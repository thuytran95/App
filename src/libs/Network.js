import _ from 'underscore';
import lodashGet from 'lodash/get';
import Onyx from 'react-native-onyx';
import HttpUtils from './HttpUtils';
import ONYXKEYS from '../ONYXKEYS';
import * as ActiveClientManager from './ActiveClientManager';
import CONST from '../CONST';
import createCallback from './createCallback';
import * as NetworkRequestQueue from './actions/NetworkRequestQueue';

let isReady = false;
let isOffline = false;
let isQueuePaused = false;
let persistedRequestsQueueRunning = false;

// Queue for network requests so we don't lose actions done by the user while offline
let networkRequestQueue = [];

// This is an optional function that this lib can be configured with (via registerParameterEnhancer())
// that accepts all request parameters and returns a new copy of them. This allows other code to inject
// parameters such as authTokens or CSRF tokens, etc.
let enhanceParameters;

// These handlers must be registered so we can process the request, response, and errors returned from the queue.
// The first argument passed will be the queuedRequest object and the second will be either the parameters, response, or error.
const [onRequest, registerRequestHandler] = createCallback();
const [onResponse, registerResponseHandler] = createCallback();
const [onError, registerErrorHandler] = createCallback();
const [onRequestSkipped, registerRequestSkippedHandler] = createCallback();

const PROCESS_REQUEST_DELAY_MS = 1000;

let persistedRequests = [];
Onyx.connect({
    key: ONYXKEYS.NETWORK_REQUEST_QUEUE,
    callback: val => persistedRequests = val || [],
});

function processRequest(request) {
    const finalParameters = _.isFunction(enhanceParameters)
        ? enhanceParameters(request.command, request.data)
        : request.data;

    onRequest(request, finalParameters);
    return HttpUtils.xhr(request.command, finalParameters, request.type, request.shouldUseSecure);
}

function removeFromPersistedStorage(request) {
    console.debug('Remove from storage: ', {request});
}

function processPersistedRequestsQueue() {
    // This sanity check is also a recursion exit point
    if (_.size(persistedRequests) === 0 || isOffline) {
        return Promise.resolve();
    }

    const tasks = _.map(persistedRequests, request => processRequest(request)
        .then((response) => {
            if (response.jsonCode !== 200) {
                throw new Error('Persisted request failed');
            }

            removeFromPersistedStorage(request);
        })
        .catch(() => {
            request.retryCount = lodashGet(request, 'retryCount', 0) + 1;
            if (request.retryCount > 10) {
                // Request failed too many times removing from persisted storage
                removeFromPersistedStorage(request);
            }
        }));

    // Do a recursive call in case the queue is not empty after processing the current batch
    return Promise.allSettled(tasks)
        .finally(processPersistedRequestsQueue);
}

function startPersistedRequestsQueue() {
    if (persistedRequestsQueueRunning) {
        return;
    }

    // NETWORK_REQUEST_QUEUE is shared across clients, thus every client/tab will have a copy
    // It is very important to only process the queue from leader client otherwise requests will be duplicated.
    if (!ActiveClientManager.isClientTheLeader()) {
        return;
    }

    persistedRequestsQueueRunning = true;

    // Ensure persistedRequests are read from storage before proceeding with the queue
    const connectionId = Onyx.connect({
        key: ONYXKEYS.NETWORK_REQUEST_QUEUE,
        callback: () => {
            Onyx.disconnect(connectionId);
            processPersistedRequestsQueue()
                .finally(() => persistedRequestsQueueRunning = false);
        },
    });
}

// We subscribe to the online/offline status of the network to determine when we should fire off API calls
// vs queueing them for later.
Onyx.connect({
    key: ONYXKEYS.NETWORK,
    callback: (network) => {
        if (!network) {
            return;
        }

        // Client becomes online, process the queue.
        if (isOffline && !network.isOffline) {
            startPersistedRequestsQueue();
        }

        isOffline = network.isOffline;
    },
});

// Try to post any persisted request after we launch the app
ActiveClientManager.isReady().then(startPersistedRequestsQueue);

/**
 * @param {Boolean} val
 */
function setIsReady(val) {
    isReady = val;
}

/**
 * Checks to see if a request can be made.
 *
 * @param {Object} request
 * @param {String} request.type
 * @param {String} request.command
 * @param {Object} request.data
 * @param {Boolean} request.data.forceNetworkRequest
 * @return {Boolean}
 */
function canMakeRequest(request) {
    if (!isReady) {
        onRequestSkipped({command: request.command, type: request.type});
        return false;
    }

    // These requests are always made even when the queue is paused
    if (request.data.forceNetworkRequest === true) {
        return true;
    }

    // If the queue is paused we will not make the request right now
    return !isQueuePaused;
}

/**
 * Checks to see if a request should be retried when the queue is "paused" and logs the command name + returnValueList
 * to give us some limited debugging info. We don't want to log the entire request since this could lead to
 * unintentional sharing of sensitive information.
 *
 * @param {Object} request
 * @param {String} request.command
 * @param {Object} request.data
 * @param {Boolean} request.data.shouldRetry
 * @param {String} [request.data.returnValueList]
 * @return {Boolean}
 */
function canRetryRequest(request) {
    const shouldRetry = lodashGet(request, 'data.shouldRetry');
    const logParams = {command: request.command, shouldRetry, isQueuePaused};
    const returnValueList = lodashGet(request, 'data.returnValueList');
    if (returnValueList) {
        logParams.returnValueList = returnValueList;
    }

    if (!shouldRetry) {
        console.debug('Skipping request that should not be re-tried: ', logParams);
    } else {
        console.debug('Skipping request and re-queueing: ', logParams);
    }

    return shouldRetry;
}

/**
 * Process the networkRequestQueue by looping through the queue and attempting to make the requests
 */
function processNetworkRequestQueue() {
    // NetInfo tells us whether the app is offline
    if (isOffline) {
        if (!networkRequestQueue.length) {
            return;
        }
        const retryableRequests = [];

        // If we have a request then we need to check if it can be persisted in case we close the tab while offline.
        // We filter persisted requests from the normal Queue to remove duplicates
        networkRequestQueue = _.reject(networkRequestQueue, (request) => {
            const shouldRetry = lodashGet(request, 'data.shouldRetry');
            if (shouldRetry && request.data.persist) {
                retryableRequests.push(request);
                return true;
            }
        });
        if (retryableRequests.length) {
            NetworkRequestQueue.saveRetryableRequests(retryableRequests);
        }
        return;
    }

    // When the queue length is empty an early return is performed since nothing needs to be processed
    if (networkRequestQueue.length === 0) {
        return;
    }

    // Some requests should be retried and will end up here if the following conditions are met:
    // - the queue is paused
    // - the request does not have forceNetworkRequest === true
    // - the request does not have shouldRetry === false
    const requestsToProcessOnNextRun = [];

    _.each(networkRequestQueue, (queuedRequest) => {
        // Some requests must be allowed to run even when the queue is paused e.g. an authentication request
        // that pauses the network queue while authentication happens, then unpauses it when it's done.
        if (!canMakeRequest(queuedRequest)) {
            if (canRetryRequest(queuedRequest)) {
                requestsToProcessOnNextRun.push(queuedRequest);
            }
            return;
        }

        processRequest(queuedRequest)
            .then(response => onResponse(queuedRequest, response))
            .catch(error => onError(queuedRequest, error));
    });

    // We clear the request queue at the end by setting the queue to retryableRequests which will either have some
    // requests we want to retry or an empty array
    networkRequestQueue = requestsToProcessOnNextRun;
}

// Process our write queue very often
setInterval(processNetworkRequestQueue, PROCESS_REQUEST_DELAY_MS);

/**
 * @param {Object} request
 * @returns {Boolean}
 */
function canProcessRequestImmediately(request) {
    return lodashGet(request, 'data.shouldProcessImmediately', true);
}

/**
 * Perform a queued post request
 *
 * @param {String} command
 * @param {*} [data]
 * @param {String} [type]
 * @param {Boolean} shouldUseSecure - Whether we should use the secure API
 * @returns {Promise}
 */
function post(command, data = {}, type = CONST.NETWORK.METHOD.POST, shouldUseSecure = false) {
    return new Promise((resolve, reject) => {
        const request = {
            command,
            data,
            type,
            resolve,
            reject,
            shouldUseSecure,
        };

        // All requests should be retried by default
        if (_.isUndefined(request.data.shouldRetry)) {
            request.data.shouldRetry = true;
        }

        // Add the request to a queue of actions to perform
        networkRequestQueue.push(request);

        if (!canProcessRequestImmediately(request)) {
            return;
        }

        // Try to fire off the request as soon as it's queued so we don't add a delay to every queued command
        processNetworkRequestQueue();
    });
}

/**
 * Prevent the network queue from being processed
 */
function pauseRequestQueue() {
    isQueuePaused = true;
}

/**
 * Allow the network queue to continue to be processed
 */
function unpauseRequestQueue() {
    isQueuePaused = false;
}

/**
 * Register a function that will accept all the parameters being sent in a request
 * and will return a new set of parameters to send instead. Useful for adding data to every request
 * like auth or CRSF tokens.
 *
 * @param {Function} callback
 */
function registerParameterEnhancer(callback) {
    enhanceParameters = callback;
}

/**
 * Clear the queue so all pending requests will be cancelled
 */
function clearRequestQueue() {
    networkRequestQueue = [];
}

export {
    post,
    pauseRequestQueue,
    PROCESS_REQUEST_DELAY_MS,
    unpauseRequestQueue,
    registerParameterEnhancer,
    clearRequestQueue,
    registerResponseHandler,
    registerErrorHandler,
    registerRequestHandler,
    setIsReady,
    registerRequestSkippedHandler,
};
