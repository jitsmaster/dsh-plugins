# dsh-api-call-tab

An **API Call** tab in the details panel of the DSH Trajectory view. Select an assistant item and the tab shows the request recorded for it:

- Command line (argv), environment variable **names** only (never values), system prompt, tools (name, description, collapsible-style input schema JSON) and stdin.
- Each section has a Copy button; long text scrolls inside the section.
- A note appears when the stored payload was truncated, with the original sizes when known.
- Assistant items without a recorded request show "API call not captured for this request". Only the claude-code adapter records requests.

It uses the `conversation.trajectory.detail.tabs` slot declared by the DSH trajectory UI. On a DSH without that slot the plugin loads and does nothing.

## Install

```powershell
dsh plugin --profile web add "github:jitsmaster/dsh-plugins#path:/dsh-api-call-tab"
```

From a local clone use a link so edits apply without reinstalling:

```powershell
dsh plugin --profile web add "link:D:/dev/ai/dsh-plugins/dsh-api-call-tab"
```

Restart the DSH server, then refresh the browser. The slot needs a DSH client build that includes it; after pulling DSH changes, rebuild the client first. Edits to `lib/client.js` only need a browser refresh.

## Tests

```powershell
node --test test/client.test.mjs
```
