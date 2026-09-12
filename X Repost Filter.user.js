// ==UserScript==
// @name         X Repost Filter
// @namespace    https://x.com/
// @version      1.0.0
// @description  Filter reposts from X List timelines before rendering
// @license      MIT
// @supportURL  https://github.com/yyIntsuki/x-repost-filter
// @incompatible Firefox-based browsers may need a hard-refresh everytime to work properly
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

// ------------------------------------------------------------
// Overview
// ------------------------------------------------------------
//
// X's "List" timelines are fetched via an XHR call to a GraphQL endpoint (ListLatestTweetsTimeline). This script hooks 
// that XHR and rewrites the JSON response before X's own code ever reads it, so ordinary reposts never reach the DOM in
// the first place.
//
// The response JSON's shape is deeply nested and not officially documented, so instead of hardcoding a path to the 
// entry list, this script walks the whole object tree looking for arrays that contain tweet-shaped entries 
// (findTweetArrays), and removes any entry that is a repost.
//
// One wrinkle: if an entire page of results is 100% reposts, removing all of them leaves X with an empty page, which 
// can break its own pagination/rendering logic. To avoid that, one "sacrificial" repost is deliberately left behind on 
// an all-repost page (see filterResponse), and a MutationObserver later hides that specific tweet with CSS once it 
// renders (see hideSacrificialRepost). This way X always has something to paginate around, but the user never sees a 
// repost.
//
// Everything else here is state (counters + window.__XRF_*__ globals) for observing/debugging this from the console.
//
// Compatibility hardening: other userscripts on x.com/twitter.com may also patch XMLHttpRequest. This script 
// now marks itself via window.__XRF_INSTALLED__ so other scripts can detect it; mirrors its filtering onto the 
// .response accessor in addition to .responseText; periodically re-verifies that its own getters are still the ones
// installed on the prototype (reinstalling if something clobbered them without chaining through); falls back to hiding 
// every repost cell at the DOM level if the network-level hooks are ever confirmed not to be running at all. None of 
// this changes filtering behavior when things are healthy.

(() => {
    'use strict';

    const TAG = '[X Repost Filter]';
    const VERSION = '1.0.0';

    // ------------------------------------------------------------
    // Idempotency guard
    // ------------------------------------------------------------

    /**
     * Protects against this script somehow running twice (engine quirks, manual re-injection while debugging, etc). 
     * Also doubles as a public marker other userscripts can check for if they want to detect this script and cooperate 
     * deliberately instead of blindly re-patching XHR, e.g.: if (window.__XRF_INSTALLED__) coexist nicely
     */

    if (window.__XRF_INSTALLED__) {
        console.warn(`${TAG} v${VERSION} skipped — already installed as v${window.__XRF_INSTALLED__}`);
        return;
    }

    window.__XRF_INSTALLED__ = VERSION;

    // ------------------------------------------------------------
    // Debug logging
    // ------------------------------------------------------------

    // Flip to true for verbose per-request/per-response logging while debugging. Errors always log regardless of this.
    const DEBUG = false;

    const log = DEBUG ? console.log.bind(console) : () => { };
    const groupCollapsed = DEBUG ? console.groupCollapsed.bind(console) : () => { };
    const groupEnd = DEBUG ? console.groupEnd.bind(console) : () => { };
    const table = DEBUG ? console.table.bind(console) : () => { };

    console.log(`${TAG} v${VERSION} loaded`);

    // ------------------------------------------------------------
    // State
    // ------------------------------------------------------------

    const xhrStates = new WeakMap();

    let listOpenCount = 0;
    let listSendCount = 0;
    let listResponseCount = 0;
    let listFilterCount = 0;

    let hiddenSacrificialReposts = 0;

    /*
     * True right after a response was filtered down to a single "sacrificial" repost (see filterResponse). Gates the
     * MutationObserver so it only scans the DOM when there's actually something pending to hide, instead of on every
     * mutation X makes to the page.
     */
    let pendingSacrificialHide = false;

    // ------------------------------------------------------------
    // Compatibility / fallback state
    // ------------------------------------------------------------
    //

    /**
     * These exist purely to detect "the XHR hooks got bypassed somehow" (e.g. another script redefined a conflicting 
     * property without chaining through this script) and fall back to hiding reposts at the DOM level instead.
     * None of this changes behavior on a healthy page where the hooks are running normally — filterResponse() and the 
     * network-level path above work exactly as before.
     */

    // Set true the moment either accessor hook actually fires for List response, proving the hooks are in and running.
    let networkHookConfirmed = false;

    // Timestamp of the first List timeline XHR .open() call, used to give the network hook a grace period before 
    // assuming it isn't running.
    let firstListOpenAt = 0;

    // True once given up on the network-level filter and switched to hiding every matching repost cell in the DOM
    // instead of just the one sacrificial cell.
    let domFallbackActive = false;
    let domFallbackHidden = 0;

    // ------------------------------------------------------------
    // URL detection
    // ------------------------------------------------------------

    // Only List timeline requests are touched; every other X XHR (home feed, search, etc.) passes through untouched.
    function isListTimelineUrl(url) {
        return (
            typeof url === 'string' &&
            url.includes('/i/api/graphql/') &&
            url.includes('/ListLatestTweetsTimeline')
        );
    }

    // ------------------------------------------------------------
    // Tweet helpers
    // ------------------------------------------------------------

    function getTweet(entry) {
        const result = entry?.content?.itemContent?.tweet_results?.result;
        return result?.tweet ?? result ?? null;
    }

    function isRepost(tweet) {
        return Boolean(tweet?.legacy?.retweeted_status_result);
    }

    // ------------------------------------------------------------
    // Find tweet entry arrays
    // ------------------------------------------------------------

    function findTweetArrays(root) {
        const arrays = [];

        function walk(value, depth) {
            if (value == null || depth > 30) return;

            if (Array.isArray(value)) {
                let containsTweet = false;

                for (const entry of value) {
                    if (getTweet(entry)) {
                        containsTweet = true;
                        break;
                    }
                }

                if (containsTweet) arrays.push(value);

                for (const item of value) walk(item, depth + 1);

                return;
            }

            if (typeof value !== 'object') return;

            for (const child of Object.values(value)) walk(child, depth + 1);
        }

        walk(root, 0);

        return arrays;
    }

    // ------------------------------------------------------------
    // Find cursors
    // ------------------------------------------------------------

    function findCursors(root) {
        const cursors = [];

        function walk(value, depth) {
            if (value == null || depth > 30) return;

            if (Array.isArray(value)) {
                for (const item of value) walk(item, depth + 1);
                return;
            }

            if (typeof value !== 'object') return;

            if (
                typeof value.value === 'string' &&
                (value.cursorType === 'Top' || value.cursorType === 'Bottom')
            ) {
                cursors.push({
                    cursorType: value.cursorType,
                    value: value.value,
                    entryId: value.entryId ?? null,
                    sortIndex: value.sortIndex ?? null
                });
            }

            for (const child of Object.values(value)) walk(child, depth + 1);
        }

        walk(root, 0);

        return cursors;
    }

    // ------------------------------------------------------------
    // Request information
    // ------------------------------------------------------------

    function parseVariables(url) {
        try {
            const parsed = new URL(url);
            const value = parsed.searchParams.get('variables');

            if (!value) return null;

            return JSON.parse(value);
        } catch {
            return null;
        }
    }

    function getRequestInfo(url, method) {
        const variables = parseVariables(url);
        const cursor = variables?.cursor ?? null;

        return {
            url,
            method,
            variables,
            cursor,
            isInitialPage: cursor === null
        };
    }

    // ------------------------------------------------------------
    // Response filter
    // ------------------------------------------------------------

    /**
     * Returns true if the JSON was actually modified (i.e. at least one repost was removed), so the caller knows 
     * whether it needs to re-stringify or can reuse the original response text.
     */
    function filterResponse(json, requestInfo) {
        const arrays = findTweetArrays(json);

        if (arrays.length === 0) {
            log(TAG, 'No recognizable tweet entry arrays');
            return false;
        }

        let originalEntries = 0;
        let originalReposts = 0;

        const arrayFlags = arrays.map(array => {
            const flags = new Array(array.length);

            for (let i = 0; i < array.length; i++) {
                const tweet = getTweet(array[i]);
                if (!tweet) {
                    flags[i] = null;
                    continue;
                }

                originalEntries++;
                const repost = isRepost(tweet);
                flags[i] = repost;
                if (repost) originalReposts++;
            }

            return flags;
        });

        const allReposts = originalEntries > 0 && originalReposts === originalEntries;

        let keptOne = false;
        let removed = 0;

        arrays.forEach((array, arrayIndex) => {
            const flags = arrayFlags[arrayIndex];
            let writeIndex = 0;

            for (let readIndex = 0; readIndex < array.length; readIndex++) {
                const flag = flags[readIndex];

                if (flag !== true) {
                    array[writeIndex++] = array[readIndex];
                    continue;
                }

                if (allReposts && !keptOne) {
                    keptOne = true;
                    array[writeIndex++] = array[readIndex];
                    continue;
                }

                removed++;
            }

            array.length = writeIndex;
        });

        // --------------------------------------------------------
        // Remaining counts
        // --------------------------------------------------------

        const remainingEntries = originalEntries - removed;
        const remainingReposts = originalReposts - removed;

        listFilterCount++;

        log(
            TAG,
            'FILTER COMPLETE',
            {
                entryArrays: arrays.length,
                originalEntries,
                originalReposts,
                removed,
                remainingEntries,
                remainingReposts,
                keptOne,
                cursor: requestInfo.cursor
            }
        );

        if (keptOne) { pendingSacrificialHide = true; }

        if (allReposts) {
            const cursors = findCursors(json);

            window.__XRF_LAST_CURSORS__ = cursors;

            groupCollapsed(TAG, 'ALL-REPOST PAGE');

            log({
                originalEntries,
                originalReposts,
                keptOne,
                cursor: requestInfo.cursor
            });

            table(cursors);

            groupEnd();
        }

        return removed > 0;
    }

    // ------------------------------------------------------------
    // Native XHR references
    // ------------------------------------------------------------

    const XHR = window.XMLHttpRequest;

    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;

    /**
     * Diagnostic only. doesn't change behavior either way. If open/send are already non-native, some other script 
     * patched XHR before this script is loaded. That's fine, this script still layers on top of it the same way it'd 
     * layer under something that patches after it, used for debugging a "reposts still showing up" report.
     */
    for (const [name, fn] of [['open', nativeOpen], ['send', nativeSend]]) {
        if (!Function.prototype.toString.call(fn).includes('[native code]')) {
            console.warn(
                TAG,
                `XMLHttpRequest.prototype.${name} already patched by another script before load, layering on top of it.`
            );
        }
    }

    const responseTextDescriptor =
        Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');

    if (
        !responseTextDescriptor ||
        typeof responseTextDescriptor.get !== 'function'
    ) {
        console.error(TAG, 'Could not find native responseText getter');

        return;
    }

    const nativeResponseText = responseTextDescriptor.get;

    /**
     * Some consumers read .response instead of .responseText, and if responseType is 'json' rather than '' / 'text', 
     * reading .responseText throws (per spec), so the hook below would never even get a chance to run. 
     * Grabbing this now lets it mirror filtering onto .response too (see "response" section further down) without 
     * depending on responseText at all.
     */
    const responseDescriptor =
        Object.getOwnPropertyDescriptor(XHR.prototype, 'response');

    const nativeResponse =
        (responseDescriptor && typeof responseDescriptor.get === 'function')
            ? responseDescriptor.get
            : null;

    if (!nativeResponse) {
        console.warn(TAG, 'Could not find native response getter — filtering will rely on responseText only');
    }

    // ------------------------------------------------------------
    // open()
    // ------------------------------------------------------------

    XHR.prototype.open = function () {
        const url = arguments[1];

        if (!isListTimelineUrl(url)) return nativeOpen.apply(this, arguments);

        // Defensive: confirm this script's hooks are still the ones actually installed on the prototype before it's 
        // used for this request. Cheap, and only runs for List timeline requests.
        ensureResponseTextHookIntact();
        ensureResponseHookIntact();

        if (!firstListOpenAt) firstListOpenAt = Date.now();

        const method = arguments[0];

        const requestInfo = getRequestInfo(String(url), method);

        xhrStates.set(
            this,
            {
                requestInfo,
                processed: false,
                filteredText: null,
                responseProcessed: false,
                filteredResponseValue: null
            }
        );

        listOpenCount++;

        log(
            TAG,
            'LIST XHR OPEN',
            {
                count: listOpenCount,
                method,
                url: String(url),
                argumentCount: arguments.length
            }
        );

        return nativeOpen.apply(this, arguments);
    };

    // ------------------------------------------------------------
    // send()
    // ------------------------------------------------------------

    XHR.prototype.send = function () {
        const state = xhrStates.get(this);

        if (state) {
            listSendCount++;

            const requestInfo = state.requestInfo;

            window.__XRF_LAST_LIST_REQUEST__ = requestInfo;

            log(
                TAG,
                'LIST XHR SEND',
                requestInfo.cursor
                    ? '(CURSOR PAGE)'
                    : '(INITIAL PAGE)'
            );

            log(TAG, requestInfo);
        }

        return nativeSend.apply(this, arguments);
    };

    // ------------------------------------------------------------
    // responseText
    // ------------------------------------------------------------

    function responseTextGetter() {
        const state =
            xhrStates.get(this);

        // Non-List XHR: return native response untouched
        if (!state) return nativeResponseText.call(this);

        // The hook is actually running for a matched List XHR, the DOM fallback checks for before ever engaging.
        networkHookConfirmed = true;

        // Already processed
        if (state.processed) return state.filteredText;

        const originalText = nativeResponseText.call(this);

        if (typeof originalText !== 'string' || originalText.length === 0) return originalText;

        // Cheap pre-check: if the raw response text doesn't even contain the repost marker, there's nothing to filter. 
        // Skip JSON.parse entirely rather than parsing every single List response just to find zero reposts.
        if (originalText.indexOf('retweeted_status_result') === -1) {
            state.filteredText = originalText;
            state.processed = true;

            return originalText;
        }

        let json;

        try {
            json = JSON.parse(originalText);
        } catch {
            return originalText;
        }

        listResponseCount++;

        groupCollapsed(TAG, 'LIST responseText');

        log({
            responseNumber: listResponseCount,
            readyState: this.readyState,
            responseType: this.responseType,
            originalLength: originalText.length,
            cursor: state.requestInfo.cursor
        });

        try {
            const modified = filterResponse(json, state.requestInfo);

            // Only re-stringify when something was actually removed. If nothing changed, reuse the original text and 
            // skip the stringify cost.
            const filteredText = modified ? JSON.stringify(json) : originalText;

            state.filteredText = filteredText;

            state.processed = true;

            log(
                TAG, 'TEXT RESPONSE FILTERED',
                {
                    modified,
                    originalLength: originalText.length,
                    filteredLength: filteredText.length
                }
            );
        } catch (error) {
            console.error(TAG, 'FILTER ERROR — returning original response', error);
            state.filteredText = originalText;
            state.processed = true;
        }

        groupEnd();

        return state.filteredText;
    }

    function installResponseTextHook() {
        Object.defineProperty(
            XHR.prototype,
            'responseText',
            {
                configurable: responseTextDescriptor.configurable,
                enumerable: responseTextDescriptor.enumerable,
                get: responseTextGetter
            }
        );
    }

    // Reinstalls responseText getter if something redefined the property without chaining through responseTextGetter. 
    // Safe to call repeatedly — a no-op whenever the hook is already intact, which is the normal case.
    function ensureResponseTextHookIntact() {
        const current = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');

        if (current && current.get === responseTextGetter) return;

        console.warn(TAG, 'responseText getter was overwritten by another script, reinstalling.');

        installResponseTextHook();
    }

    installResponseTextHook();

    // ------------------------------------------------------------
    // response
    // ------------------------------------------------------------

    /*
     * Mirrors the same filtering onto .response, fully independently of the responseText path above (own state fields, 
     * own parse). Two reasons this exists as its own self-contained hook rather than being merged into 
     * responseTextGetter:
     *   1. If a consumer reads .response while responseType is 'json', .responseText throws per spec — the hook above 
     *      never gets a chance to run at all in that case.
     *   2. Keeping it fully separate means it can never change what responseTextGetter returns, even in the worst case.
     * If a request happens to be read through both accessors, this reuses responseText's already-filtered result 
     * instead of re-parsing.
     */

    let ensureResponseHookIntact = () => { };

    if (nativeResponse) {
        const responseGetter = function () {
            const state = xhrStates.get(this);

            if (!state) return nativeResponse.call(this);

            networkHookConfirmed = true;

            const responseType = this.responseType;

            // responseText path already ran for this XHR — reuse its result instead of parsing/filtering a second time.
            if (state.processed) {
                if (responseType === '' || responseType === 'text') return state.filteredText;

                if (responseType === 'json') {
                    try { return JSON.parse(state.filteredText); } catch { return nativeResponse.call(this); }
                }

                return nativeResponse.call(this);
            }

            if (state.responseProcessed) return state.filteredResponseValue;

            const originalValue = nativeResponse.call(this);

            // Only text/json bodies are worth touching; blob/arraybuffer/document responses are passed through.
            if (responseType !== '' && responseType !== 'text' && responseType !== 'json') return originalValue;

            const originalText =
                (typeof originalValue === 'string')
                    ? originalValue
                    : (originalValue == null ? '' : JSON.stringify(originalValue));

            if (
                typeof originalText !== 'string' ||
                originalText.length === 0 ||
                originalText.indexOf('retweeted_status_result') === -1
            ) {
                state.responseProcessed = true;
                state.filteredResponseValue = originalValue;

                return originalValue;
            }

            try {
                const json =
                    (typeof originalValue === 'string')
                        ? JSON.parse(originalValue)
                        : JSON.parse(JSON.stringify(originalValue));

                filterResponse(json, state.requestInfo);

                state.filteredResponseValue = (responseType === 'json') ? json : JSON.stringify(json);

                state.responseProcessed = true;
            } catch (error) {
                console.error(TAG, 'response FILTER ERROR — returning original response', error);

                state.filteredResponseValue = originalValue;
                state.responseProcessed = true;
            }

            return state.filteredResponseValue;
        };

        const installResponseHook = () => {
            Object.defineProperty(
                XHR.prototype,
                'response',
                {
                    configurable: responseDescriptor.configurable,
                    enumerable: responseDescriptor.enumerable,
                    get: responseGetter
                }
            );
        };

        ensureResponseHookIntact = () => {
            const current =
                Object.getOwnPropertyDescriptor(XHR.prototype, 'response');

            if (current && current.get === responseGetter) return;

            console.warn(
                TAG, 'response getter was overwritten by another script without chaining through here, reinstalling.'
            );

            installResponseHook();
        };

        installResponseHook();
    }

    // ------------------------------------------------------------
    // DOM sacrificial repost hiding
    // ------------------------------------------------------------

    function findRepostCells() {
        const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');

        const result = [];

        for (const cell of cells) {
            const repostIcon = cell.querySelector('[d^="M4.75 3.79l4.603"]');

            // This path data is the same visual repost-arrow icon used by the old uBlock filter this script replaces.
            if (!repostIcon) continue;

            // Skip tweets the user has explicitly re-retweeted themselves — those show the same icon but aren't the 
            // kind of "repost" this script filters.
            if (cell.querySelector('[data-testid="unretweet"]')) continue;

            result.push(cell);
        }

        return result;
    }

    // ------------------------------------------------------------
    // DOM fallback (network hook health check)
    // ------------------------------------------------------------

    function hideAllRepostCellsFallback() {
        const cells = findRepostCells();

        for (const cell of cells) {
            if (cell.dataset.xrfSacrificialHidden === '1') continue;

            cell.dataset.xrfSacrificialHidden = '1';
            cell.style.display = 'none';

            domFallbackHidden++;
        }

        if (domFallbackHidden > 0) log(TAG, 'DOM FALLBACK HID REPOSTS', { count: domFallbackHidden });
    }

    function activateDomFallback(reason) {
        if (domFallbackActive) return;

        domFallbackActive = true;

        console.warn(
            TAG,
            'Network-level filtering does not appear to be running — falling back to DOM-level hiding for all reposts.',
            reason
        );

        hideAllRepostCellsFallback();
    }

    /**
     * Gives the network hooks a grace period after the first List request before concluding they aren't running. 
     * On a healthy page this never fires — networkHookConfirmed flips true the first time a List response is actually
     * read through responseText/response.
     */
    function checkNetworkFilterHealth() {
        if (domFallbackActive) return;
        if (networkHookConfirmed) return;
        if (!firstListOpenAt) return;

        if (Date.now() - firstListOpenAt > 4000) {
            activateDomFallback('no List response was read through the XHR hooks within 4s of the first List request');
        }
    }

    setInterval(checkNetworkFilterHealth, 2000);

    function hideSacrificialRepost() {
        const cells = findRepostCells();

        if (cells.length === 0) return;

        // Only hide ONE repost per scan.
        // This is deliberate. The network filter has already removed all other reposts before rendering.
        const cell = cells[0];

        if (cell.dataset.xrfSacrificialHidden === '1') return;

        cell.dataset.xrfSacrificialHidden = '1';

        // Use display:none rather than removing the node.
        // This gives the least disruptive DOM modification possible for the pagination experiment.
        cell.style.display = 'none';

        hiddenSacrificialReposts++;

        // Nothing left pending until the next response comes back with another sacrificial repost to look for.
        pendingSacrificialHide = false;

        log(TAG, 'HID SACRIFICIAL REPOST', { count: hiddenSacrificialReposts, cell });
    }

    // ------------------------------------------------------------
    // MutationObserver
    // ------------------------------------------------------------

    const observer =
        new MutationObserver(() => {

            // DOM fallback mode: the network-level hooks don't appear to be running (see checkNetworkFilterHealth), 
            // so hide every repost cell found instead of relying on the XHR filter.
            if (domFallbackActive) {
                hideAllRepostCellsFallback();
                return;
            }

            // Skip the DOM scan entirely unless a response was just filtered down to a sacrificial repost. Without this
            // gate, every mutation anywhere on the page (which is constant on X) would trigger a full document query.
            if (!pendingSacrificialHide) return;

            hideSacrificialRepost();
        });

    function startObserver() {
        if (!document.documentElement) return;

        observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true
            }
        );

        if (domFallbackActive) hideAllRepostCellsFallback();
        if (pendingSacrificialHide) hideSacrificialRepost();

        log(TAG, 'DOM observer started');
    }

    if (document.documentElement) {
        startObserver();
    } else {
        const startupObserver =
            new MutationObserver(() => {
                if (document.documentElement) {
                    startupObserver.disconnect();
                    startObserver();
                }
            });

        startupObserver.observe(
            document,
            {
                childList: true,
                subtree: true
            }
        );
    }

    // ------------------------------------------------------------
    // Debug globals
    // ------------------------------------------------------------

    // Inspect via `__XRF_STATE__` in devtools console to check the script is running and filtering as expected.
    window.__XRF_STATE__ = {
        get listOpenCount() { return listOpenCount; },
        get listSendCount() { return listSendCount; },
        get listResponseCount() { return listResponseCount; },
        get listFilterCount() { return listFilterCount; },
        get hiddenSacrificialReposts() { return hiddenSacrificialReposts; },
        get pendingSacrificialHide() { return pendingSacrificialHide; },
        get networkHookConfirmed() { return networkHookConfirmed; },
        get domFallbackActive() { return domFallbackActive; },
        get domFallbackHidden() { return domFallbackHidden; },
        get lastRequest() { return (window.__XRF_LAST_LIST_REQUEST__ ?? null); },
        get cursors() { return (window.__XRF_LAST_CURSORS__ ?? []); }
    };

    console.log(`${TAG} v${VERSION} hooks installed`);
})();
