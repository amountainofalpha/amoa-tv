# TODO

- **Persist config across reinstalls.** Removing the extension wipes
  `chrome.storage.local` (overlays + colors, settings, Pine IDs, auth).
  Options: Export/Import buttons in the popup (overlays + settings as
  JSON), and/or move config to `chrome.storage.sync` so it survives
  reinstalls and roams across the user's Chrome profile.
