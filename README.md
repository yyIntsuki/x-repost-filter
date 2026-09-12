# X Repost Filter

A userscript that removes reposts ("retweets") from **X List timelines**, before they're ever rendered — not hidden with CSS after the fact, filtered out of the network response itself.

## Why

~~Because X (formerly Twitter) is an indie social platform that cannot simply disable reposts in Lists even after 17 years.~~

Solutions like using uBlock Origin cosmetic filter, extensions, and other userscripts hides reposts **after** they are loaded, which can cause the page cursor to jump randomly when a large number of reposts are loaded.

X's List timelines are fetched via an XHR call to a GraphQL endpoint (`ListLatestTweetsTimeline`). This script hooks that request and rewrites the JSON response before X's own code ever reads it, so ordinary reposts never reach the DOM in the first place. This replaces an older uBlock Origin cosmetic filter that just hid repost elements with CSS after they'd already rendered.

## Installation

1. Install a userscript manager — [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) both work.
2. Install the script:
   - Open `X Repost Filter.user.js` in this repo and click **Raw**; your userscript manager should offer to install it automatically.
   - Or copy the file's contents into a new script in your manager's dashboard.
3. Reload x.com / twitter.com. You should see `[X Repost Filter] vX.Y.Z loaded` in the browser console.

## How it works

The response JSON's shape is deeply nested and undocumented, so instead of hardcoding a path to the entry list, the script walks the entire response tree looking for arrays that contain tweet-shaped entries, and removes any entry that's a repost (`findTweetArrays` / `isRepost`).

**The "sacrificial repost" trick:** if an entire page of results is 100% reposts, removing all of them would leave X with an empty page, which can break its own pagination. To avoid that, one repost is deliberately left in on an all-repost page (`filterResponse`), and a `MutationObserver` hides that specific tweet with CSS (`display: none`) once it renders (`hideSacrificialRepost`). X always has something to paginate around; the user never sees a repost.

Only List timeline requests are touched (`isListTimelineUrl`) — every other request (home feed, search, etc.) passes through completely untouched.

## Compatibility with other userscripts

Since this script works by patching `XMLHttpRequest.prototype`, it's designed to coexist safely with other userscripts that do the same thing on x.com:

- **`window.__XRF_INSTALLED__`** — set once the script installs, so other scripts can detect it and avoid redundant patching.
- **Filters both `.responseText` and `.response`** — some code paths read one or the other (and `.responseText` throws if `responseType` is `'json'`), so both are covered independently.
- **Self-healing hooks** — before each List request, the script verifies its own getters are still the ones installed on `XMLHttpRequest.prototype`, and silently reinstalls them if something else redefined the property without chaining through it.
- **DOM-level fallback** — if the network-level hooks are ever confirmed to not be running at all (e.g. something clobbers them in a way the check above can't catch), the script falls back to hiding every detected repost cell directly in the DOM after a short grace period, instead of silently doing nothing.

All of this is defensive; on a normal, healthy page none of it changes the filtering behavior described above.

## Debugging

Open the browser devtools console:

```js
// Flip DEBUG to true at the top of the script for verbose per-request logging.

window.__XRF_STATE__
// {
//   listOpenCount, listSendCount, listResponseCount, listFilterCount,
//   hiddenSacrificialReposts, pendingSacrificialHide,
//   networkHookConfirmed, domFallbackActive, domFallbackHidden,
//   lastRequest, cursors
// }
```

- `listFilterCount` should climb as you scroll through a List — each increment is one response with at least one repost removed.
- `networkHookConfirmed: true` means the script's XHR hooks are actively running.
- `domFallbackActive: true` means the network-level filter wasn't detected as running, and the script is hiding reposts at the DOM level instead — this is a signal something's interfering with the XHR patch (e.g. another script) and worth reporting as an issue.

## Limitations

- Only affects **List** timelines, not the home feed, search, or individual profile timelines.
- Relies on X's GraphQL response shape continuing to include `retweeted_status_result` on repost entries; if X changes that shape, filtering may silently stop working (the DOM fallback exists partly as a safety net for this).
- Assumes the List timeline is fetched via XHR. If X ever migrates that endpoint to `fetch()`, this script won't see it.
- **Firefox**-based browsers are **NOT** reliably supported due to security implementations. If you use Firefox-based browsers, use a hard-refresh.

## License

MIT
