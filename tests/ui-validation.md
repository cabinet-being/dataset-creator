# UI/UX validation — 2026-10-06

## Automated checks

Passed after the UI changes:

- `npm run build` — TypeScript and production build. Existing ONNX Runtime eval and bundle-size warnings remain.
- `npm run test:ui-workflows` — Ukrainian/English physical key matching, modifiers and IME/AltGraph guards; save failure/retry and snapshot serialization; Undo/Redo with an intervening edit; operation cancellation; import pre-cancellation; export scope, captions, ordering, missing assets, ZIP/folder parity, collision preflight, permissions, and cancellation. PSD conversion is checked with a simulated Photopea messaging protocol, not the external editor.
- `npm run test:project-types` — project serialization, Dataset migration/layout, physical Dataset export and versions.
- `npm run test:workspace-layout` — dock placement, geometry, pinning, persistence and migration.
- `npm run test:video-frames` — frame-selection rules, cancellation, cache indexing and safe PNG writes.

These tests do not establish native file-picker behavior, actual screen-reader usability, live PSD conversion, or local ONNX inference on a user-supplied model.

## Main UI browser checks

Local Vite application, in-app browser, 1292 × 1046 screenshot dimensions. Three synthetic 320 × 240 PNG images; temporary workspace.

- Imported all three images from the Files picker.
- Opened Review using Ctrl+K; `/` focused its search. Searching `amber` matched the original filename despite the workspace using an ID filename.
- Selected two images with Space and Shift+Right; D added them to Dataset.
- Focused Explorer and pressed E. Gallery selection remained included; the most recent history entry remained Add to Dataset.
- Opened Caption, entered `портрет, test`, and used Ctrl+Enter. Tags appeared on the first image and focus moved to the second caption input.
- Opened Export using the palette. Preview contained exactly the selected two images and the saved caption.
- Ran Export using the keyboard. Operations reported completed, 2/2, and two images/captions exported; focus returned to the Export button. ZIP payload equivalence is separately covered by the automated test.
- Inspected the dark Export screen and operation details visually.

Browser zoom shortcuts were not delivered by the available in-app control. A 200% browser zoom check remains unverified.

## Navigation and responsive workspace follow-up

Rebuilt and reran all four test scripts after the navigation changes; all passed. The workflow suite now checks history state validation, distinct file-view identifiers, removal of stale `tool` URLs, preservation of unrelated URL parameters/history state, and compact layout projection. The dock suite checks the Welcome destination after closing editors and reopening into that space without creating another split.

In the real app, temporary workspace in the in-app browser:

- Export → Open Dataset removed `tool` from the URL. Browser Back restored Export; Forward restored Dataset and focused its panel.
- Entered `layout-check` in Dataset's Trigger. Back/Forward retained it. Closing Dataset and navigating Back reopened it with the same value.
- With viewport overrides of 640 × 720 and 320 × 720, the main editor remained available. At 640 px, Explorer opened over it; Escape dismissed Explorer and returned focus to Dataset. At 320 px, document scroll width equalled viewport width, and the Dataset panel had no horizontal overflow.
- Returning to 1280 × 720 restored Explorer, Inspector and Dataset with the entered Trigger value. This is a resize check; it does not establish preservation of every floating/pinned layout variant.
- Closing all editors originally allowed Inspector to take the entire main area. Fixed and retested: Welcome remains available. Opening Import uses the empty editor area (717 px in this layout), without an extra Welcome split. Back returns to Welcome while keeping the Import tab; Forward restores Import. The temporary viewport override was reset afterward.
- No browser console errors appeared in the inspected log during the Dataset navigation checks.

Still to check separately: history for real file tabs and cross-project/reload recovery, multiple active editor groups, actual browser zoom 200%, screen readers, pinned/floating variants and native file permissions. These browser results use empty tools and one temporary Dataset field; they do not prove full workflow completion.

## Gallery benchmark

Reproduce with the dev server at `/DatasetCreator/tests/ui-browser.html`, then **Run gallery benchmark**. It compares the current `BrickMasonry` with `AssetGallery`, using the same card component and a shared synthetic preview. One run, not a statistical performance guarantee. Render/select timings include two animation frames. Memory includes earlier trials and is not a retained-memory or leak measurement.

| View | Assets | Render, ms | Select, ms | Mounted images | Horizontal overflow at 920 px |
|---|---:|---:|---:|---:|---|
| Masonry | 100 | 134 | N/A | 100 | No |
| Masonry | 1000 | 972 | N/A | 1000 | No |
| Masonry | 5000 | 3989 | N/A | 5000 | No |
| Gallery | 100 | 74 | 48 | 100 | No |
| Gallery | 1000 | 67 | 45 | 100 | No |
| Gallery | 5000 | 88 | 68 | 100 | No |

The gallery renders a page of 100 items. It does not mount all 5000 cards or claim full scrolling virtualization. Selection/search still operates across the filtered collection. The browser-reported heap varied from 34 to 92 MB across the combined trials; this does not prove a memory reduction.

Also visually checked the gallery in a 320 px panel in light mode: search, filters, selection actions and preview controls wrapped without clipping. Real image decoding, caption controls, changing groups, page-boundary preview focus and long-running operations need separate scenarios.

## Active-document save commands and live Photopea

Use `/DatasetCreator/tests/document-browser.html`. This development harness renders the real `PhotopeaBlobViewer`, command provider, document buttons and operation status. It generates a synthetic 32 × 32 PNG locally; the second editor registers a different Save command. Write callbacks can be delayed or rejected without touching a project directory. The Photopea message contract and custom Open/Save handlers were checked against the official [Live Messaging API](https://www.photopea.com/api/live) and [Environment API](https://www.photopea.com/api/environment).

Observed in the in-app browser:

- Live Photopea loaded the synthetic PNG. Save returned a 2024-byte PSD with the `8BPS` signature and a 121-byte preview; the harness completed its write callback. This verifies live messaging and conversion, not a native filesystem write or full PSD layer fidelity.
- Holding the write kept Save / Save copy disabled and showed `Saving PSD…`; another Ctrl+S did not add a second request. Releasing it produced `Saved PSD.`. With operation tracking added, the footer remained `1 running` while held and then reported `completed`, `1/1`.
- Rejecting Save copy produced `Unable to save PSD copy.` and `Write failed`; no false success appeared.
- Focusing the second editor and pressing Ctrl+S incremented only its save counter. Its unavailable Save copy action stayed disabled; the Photopea write log did not change.
- File → Save and Ctrl+S with focus inside the actual Photopea iframe both returned a PSD and preview through the same callback.
- With focus inside that iframe, Ctrl+O invoked the outer file-selection command and moved focus to the harness's file-selection stand-in (its textarea). In App this registered command focuses Explorer. A plain Tab inside Photopea changed its panel visibility, so Tab alone is not treated as the exit route.

The unit suite now checks command ownership, disabled reasons, availability snapshots and unregistering an inactive editor without removing the active command. An HMR-only duplicate `createRoot` warning in the development harness was addressed with disposal on hot replacement. Still required: real project PSD writes and reload, failure/retry for edited workspace assets, full native-file verification of per-document dirty-state (the legacy `editToolbar` was removed on 2026-10-07), and keyboard verification across supported browsers/platforms.


## Dataset board extraction — 2026-10-06

- Production build and `npm run test:ui-workflows` pass after extraction. Regression assertions cover explicit empty caption overrides, missing-override fallback, disabled overrides, source immutability and numeric aspect sorting.
- In the app, imported three synthetic 320×240 PNGs through the file chooser, added all three through Add Visible, and confirmed Dataset reports 3 assets / 0 captions with all three previews.
- Trigger `board-check` survived navigation to Add files, Import, and back. Dataset options are available with Inspector hidden.
- At viewport 320×720: document width 320, Dataset panel client/scroll width both 280; all measured input/button/select horizontal bounds fit the viewport. Search for original filename `blue` leaves only blue.png. Reset viewport after verification.
- These checks do not cover native directory writes, drop/suggestion Undo parity, reload recovery, screen readers, or the complete keyboard workflow.


## Dataset membership and persistence — 2026-10-06

- `test:ui-workflows` now tests the shared intake action used by gallery, drop and suggestions: deduplication, a single undo entry for mixed image/PSD intake, no history entry for an existing member, restored order and preservation of later trigger edits, redo and gallery removal undo.
- A test directory handle exercises `writeProjectDirectoryChanges` with a linked `.dataset.json`. Rejecting that document's writable stream makes `createSaveQueue` fail and stay dirty; retry writes the latest trigger/membership, and restoring the previous snapshot restores the linked document. This is a simulated file-access failure, not a native directory test.
- Build plus UI workflows, project types, workspace layout and video-frame suites pass. App routes Dataset settings, drop import metadata and shared workspace indexing through the save queue. Other direct filesystem mutations remain outside this verified scope.
- Drop is registered with OperationStatus until completion/failure so existing close/project-switch guards apply. Native drop behavior and its full keyboard alternative remain to be exercised in the browser.


## Per-document unsaved changes — 2026-10-07

The integration uses Photopea's [document scripting model](https://www.photopea.com/learn/scripts) and [live messaging](https://www.photopea.com/api/live). Live probing confirmed that `activeDocument.saved` is true after opening, false after New Layer, and true after PSD serialization even if the host write subsequently fails. The host therefore keeps its own pending/failed-write state.

Verified in `tests/document-browser.html` with a synthetic 32×32 PNG and the actual Photopea iframe:

- New Layer → Check close reports confirmation required. A failed callback keeps the outer dirty state even after the iframe clears its own marker. Save copy also retains the original's dirty state.
- Hold write → Save → New Layer while writing → Finish write keeps Layer 2 in the iframe and reports confirmation required. Repeated this with the harness replacing its parent file Blob and changing the filename from PNG to PSD on success: the live document still retains the later edit.
- A subsequent successful save changes the outer state to clean and Check close reports Safe to close. PSD payload grew from 3162 to 3888 bytes after the second layer. No real filesystem write was used in this harness.
- Unit tests cover isolation between document registrations, querying current state rather than stale badges, old-owner cleanup, replaced editors during an asynchronous check, and rejected checks. Build and UI workflow tests pass.

The App calls this guard before closing views, returning from a nested editor, and switching projects. Cleanup also uses it and keeps the editor open for changes made while saving. Those full native-file/cleanup/close-dialog flows remain unverified in the browser. Browser reload uses the last observed state; full recovery of unsaved iframe edits is not implemented.

## Real browser filesystem persistence — 2026-10-07

Use `tests/persistence-browser.html`: Write fixture, reload the page, then Reopen saved fixture. The harness uses an isolated UUID folder in OPFS and does not access a user-selected project directory or the application project store.

- Before the fix, reopening lost `dataset.filePath` although membership and captions survived. The project manifest now retains that link and derives its parent path when reopening; project creation also writes the named Dataset document.
- After the fix, the browser wrote actual 32×24 PNG and JPEG files, queued a newer snapshot while the first write was held, and confirmed one writer and a saved latest snapshot.
- Both immediate reopening and reopening after a page reload passed: two files, final trigger, reversed order, caption override, named Dataset agreement, exact image bytes and captions (including the final newline) in both ZIP and directory exports. Each directory export uses a fresh fixture subfolder.
- Automated workflow tests cover subsequent edits reaching the named file after reopening, nested paths, legacy manifests without a link, invalid stored paths, initial creation, and the existing failed-write/retry behavior. Build and workflow tests passed; the final UI-only change also passed build and diff whitespace checks.
- This does not verify native folder permissions, the application Open dialog, restored editor tabs, or live PSD export conversion.

Empty-state actions now connect Dataset Add files to Import, Dataset Review to Add files, and Project Review to Import. The real app's empty Dataset → Add files → Import path was exercised in the browser; the other two callbacks were checked by reading their integration and building the app.

## Filesystem operations and the save queue — 2026-10-07

- `createSaveQueue.runExclusive` drains earlier edits, reserves the same write lane for a filesystem action, then persists the latest state with updated references. A flush requested during the action waits. Page unload considers outstanding file operations unsaved. The callback must not call flush itself.
- Unit checks hold an initial save and a rename separately; autosave cannot run midway through rename, later metadata wins, changes preceding a partial failure still persist, a failed action does not poison the queue, and a stopped queue cannot start another file action.
- The OPFS harness uses the actual Explorer rename service on the linked Dataset file, holds the action after rename, enqueues a metadata edit and flush, then completes it with the updated path. It confirms the old path was not recreated, the concurrent project-name edit survived, and reopened captions/images still match ZIP/directory exports.
- App rename/delete use that lane and OperationStatus; delete checks affected document states before removing files and updates workspace references after each successful deletion. Import's per-image manifest update now uses the queue. The browser test verifies the service/queue with real files, not App's native picker or deletion dialog.
- Remaining: integrate move/paste, background indexing, version restore and other direct writes; verify complete native UI flows. Serialization of rename/delete alone does not prove all filesystem operations are coordinated.

## File editor identity across rename — 2026-10-07

- File view ids are independent of paths. `moveFileTab` updates the path/name and retains the id, Blob, pin and dirty metadata; App applies it to open and recently closed views. Reopening looks up the latest path and view mode before allocating an id. Async file reads from an earlier project session cannot open a tab in the new project.
- Unit tests verify editor identity, file/dirty/pin retention, folder-prefix boundaries, separate viewer/editor modes, lookup by the renamed path, and availability of the previous path for another file. Build and UI workflows passed.
- In the live Photopea harness: New Layer → Rename document changed the outer target to `Project/renamed-fixture.png`, while the iframe retained Layer 1 and its New Layer history entry. Check close reported dirty/confirmation. Save returned a 3162-byte PSD and 121-byte preview through the callback with the renamed target. After the callback changed the outer file to PSD, the layer remained and Check close reported clean/Safe to close.
- The harness keys its editor by the same view id and uses the shared path-update helper. This proves retention in a live iframe, but it is not a native Explorer rename or filesystem write. Full browser-history restoration and concurrent native rename/save workflows remain unverified.

## Project save-session isolation — 2026-10-07

- `saveSession.ts` listens to the directory store synchronously and binds one save queue to that directory and its initial project id. `useProjectSave` owns this controller for its mounted lifetime; changing the folder no longer waits for React to rerender before subscribing to new project edits.
- Unit tests hold a write to A, disconnect it, load B, connect folder B and immediately change B. The writes retain their own project/folder and correct baseline. Completing A cannot change B's status. A project-id change without a folder handshake disconnects writes, and disposal unsubscribes pending edits.
- App now awaits opening-time indexing inside the file-operation lane, reports progress and validates the project/directory before applying discovered sources. Indexing no longer owns a background continuation that writes whichever project happens to be current into an older folder. Version creation uses the same lane; App has no direct `writeProjectDirectoryChanges` calls.
- Creation keeps the current workspace until the new files are created. Opening/creation makes the workspace inert while its setup dialog remains outside that DOM subtree. Workspace commands and legacy Explorer shortcuts are disabled during the operation.
- Browser check: File → New Project Directory; entered `Session check`, selected Style, observed enabled continuation; Escape returned to the unchanged temporary workspace. After adding focus restoration, repeating New → Escape focused File. No native picker or user directory was used.
- Build, UI workflows and project types passed. These checks do not prove native permission failures, a full real-folder project switch, or version restoration. Move/paste and restore coordination remain outstanding.

## Explorer intake and partial file operations — 2026-10-08

- `npm run test:ui-workflows`, `npm run test:project-types`, production build and `git diff --check` passed. Build retains the existing ONNX eval, chunk size and stale Browserslist warnings.
- Explorer Add to Dataset now calls the shared membership action. Tests mix an indexed source (both Explorer and relative paths) with an unindexed file path, repeat intake, undo and redo. The source object, original path and Blob remain identical; one batch creates one history entry and repeated intake adds none.
- Move, copy and duplicate batches now expose completed paths, the failing path and its cause through `ExplorerBatchError`. Tests fail on the second of three entries, check the first destination's actual contents, preserve originals for copy/duplicate, verify move callbacks occur before the next attempt, and verify a same-parent move leaves the filename unchanged.
- A file can move successfully before metadata cleanup fails. Both a simulated native move and the copy/delete fallback are tested with a failing old-sidecar deletion: the destination keeps the image and its identity, the error reports the completed move, and the reference callback runs exactly once.
- App refreshes Explorer after success or failure. Duplicate now indexes successful shared copies in its finally path, matching paste. These App integrations were checked by reading the code and building; the tests invoke the actual service with in-memory handles, not a native browser directory chooser.
- Version-restore regression tests also passed in the project-types suite: failed snapshot application or validation restores previous files and the version pointer; invalid archive paths are rejected; failed recovery retains a backup. This does not prove native permission handling.

Remaining filesystem work: partial copies and failures before an individual operation returns, rename metadata failure, moving a shared source outside shared without losing dependent edited assets, and native UI permission/retry flows. The earlier 2026-10-07 outstanding lists are historical; move/paste and restore now have coordination code, but full end-to-end acceptance remains open.

## Rename recovery, partial copies and moved sources — 2026-10-08

Production build, project-types, UI-workflows and diff whitespace checks pass after these changes.

- Rename and move share a relocation implementation. Tests combine native-like move and copy/delete fallback with failed metadata writing and failed old-sidecar cleanup. Committed changes invoke the reference callback once; pre-commit failures leave the original. Rename rejects a pre-existing target sidecar without touching either file.
- Failed writes abort their writable stream when supported. An incomplete file/sidecar or recursively copied folder is removed after copying fails. Tests confirm originals and unrelated files survive; denied cleanup reports the exact remaining destination.
- Relative asset path updates now include their associated `.manifest.json`. Tests cover filenames, folders, undefined paths and unrelated shared prefixes. App applies this helper to both source and edited-asset metadata paths. Rename's callback also updates selection and closes the stale inline editor after a committed rename.
- Registered sources can move outside shared without removal of dependent edited assets. The project reader follows explicit source manifests at their new locations; discovery remains shared-only. The serializer/service test moves a source to Archive, saves and reopens, then moves it back. It checks source bytes/id/tags, Dataset membership/order/overrides, and dependent image and PSD bytes.
- Live OPFS harness: Write fixture passed the existing Dataset rename/concurrent-save checks, then renamed the PNG using the same path helper and save queue. Reopening retained its source id and new sidecar path; old metadata was not recreated. Both immediate verification and Reopen saved fixture after a full page reload passed exact PNG/JPEG bytes, final captions/order, linked Dataset and ZIP/directory parity.

The browser result uses isolated synthetic OPFS files. It does not prove the full App Explorer/native-picker flows or native permission denial. The source-with-edited-assets move uses in-memory filesystem handles; a real UI move remains a separate acceptance check. A fallback move that copies successfully but fails while deleting the original, and broader file-operation recovery, still need explicit review.

## Failed snapshot writes and retry isolation — 2026-10-08

- Removed the early project-manifest write that omitted asset maps when project metadata changed. The manifest now retains its prior contents until the asset write stage succeeds.
- The asset stage waits for all started operations to settle before rejecting. A failed writer therefore cannot release the save lane while a sibling is still writing the old snapshot.
- The project-types regression test uses two registered sources outside shared: one sidecar writer rejects and the other is held. It checks the save remains pending and the manifest remains byte-identical, releases the held writer, verifies both source identities survive reopening, then retries and verifies the new name, tags and original bytes.
- Project-types tests, production build and diff whitespace checks passed. This uses in-memory filesystem handles, not native permission denial. It does not provide transaction rollback: sidecars that succeeded can contain newer metadata even though the overall save failed.

## Explorer keyboard focus — 2026-10-08

- ExplorerTree renders a non-button row during rename, avoiding an input nested in a button. Rename/create inputs have accessible names; folder buttons expose expansion. Ending inline editing restores row focus only when the removed input left focus on body.
- App keyboard movement now focuses and scrolls the matching DOM row. Home/End follow visible order, initial Down does not skip the first child, and a collapsed root excludes its hidden descendants. Focusing a row also updates the active Explorer context.
- Browser check in the actual empty workspace: focus root → Shift+F10 opens New Folder / Import and focuses New Folder; Escape closes the menu and focuses the root again. Production build passes. This does not verify populated-tree arrows, range selection, inline rename completion or native filesystem operations.

### Populated Explorer in the actual App

`tests/explorer-browser.html` creates a UUID OPFS directory with the normal project serializer, adds Keyboard/alpha.txt, beta.txt and gamma.txt, connects the real stores and mounts App under the normal providers and StrictMode. It uses no user-selected folder. The App shares the normal origin's UI preferences, so this fixture is intended for a development browser profile.

- Expand Keyboard → Down → F2 focuses the labelled Rename alpha.txt input. Escape restores focus to alpha.txt.
- Renaming alpha.txt to renamed.txt originally left body focused because the row remounted under its new path. Focus recovery now belongs to the stable root and waits for the refreshed destination row. Repeating rename back to alpha.txt focused that row and the open text viewer retained `Fixture alpha.txt`.
- Two Shift+Down presses selected exactly alpha.txt, beta.txt and gamma.txt, with DOM focus on gamma.txt. Home focused dataset, End focused src, matching the visible first and last entries.
- Home → Down → Shift+F10 → Enter opened New folder name. Entering Created here and pressing Enter created the folder and focused its row.
- Row buttons expose their selected state through aria-pressed. These checks cover the actual App callbacks and browser-backed OPFS writes; native directory permissions, screen-reader announcements, and full project-switch/reload flows remain separate checks.

## Shared tool renderer — 2026-10-09

- WorkspaceTool replaces the Project and Dataset rendering switches and direct file Analysis/Caption instances. Its props discriminate project, dataset and file contexts; dataset update/add callbacks stay with their dataset id and file tools receive a file target. Existing lazy-loading boundaries remain in place.
- The actual App fixture opened Import with Files/Folder controls, Dataset → Review with the Dataset Inspector context, and Review → Add files with the proper selection mode and Import files action. Project Remove Duplicates remains a separate behavior from Dataset Add files.
- Production build, UI-workflow suite and diff whitespace checks passed after integration. These browser checks use empty image collections and do not prove populated asset mutations, local model execution or scope isolation across simultaneous views. Video and file Photopea still use their existing App branches; selection scope remains coordinated in App.

## Per-view tool selection — 2026-10-09

- Removed App's global Analysis and Caption selection state. Each tool tab now carries its own scope; opening an unrelated tool no longer clears its neighbors. An explicit project-wide invocation clears only the addressed view, while a replacement selection clears its old nested editor.
- Project activation clears temporary scopes. The persisted tab serializer continues to store identifiers only. Closed-tab restoration keeps the live scope, and file/folder moves update Analysis targets in both open and closed tabs without replacing their Blobs or view ids.
- UI-workflow regression tests cover neighboring Analysis/Caption selections when Review opens, replacing Caption scope, clearing only Analysis scope, keeping pinned state, dropping stale nested editors, and folder moves with Blob identity retained. Production build and diff whitespace checks pass. Populated-image UI checks across simultaneous dock groups remain outstanding.

## Explicit empty selection and path-backed identity — 2026-10-09

- WorkspaceTool accepts an explicit selection context, with Analysis files or Caption item ids. Unit tests verify an empty array remains selection scope, absent scope becomes project scope, and unrelated tool scopes are ignored.
- Analysis determines file scope by supplied props, not array length, and returns the scoped items before its base-items fallback. Caption uses an empty Set for an explicit empty list. This corrects the previous expansion of empty selection to all project items; the component behavior is code-reviewed and built, but not yet browser-verified.
- Added tests/scope-browser.html and scope-browser.tsx with one synthetic PNG and controls for project versus empty selection in the actual WorkspaceTool components. Browser opening was denied by automatic approval review because the usage limit was exhausted. No browser result is claimed and no alternate browser transport was used.
- Regression tests also cover renamed path-backed Caption item ids, the nested selected item and file-caption view identity. Source ids stay stable. Analysis targets update path-backed ids with their paths. UI-workflow suite, production build and diff whitespace checks pass.

## Deletion and scoped views — 2026-10-09

- App now prunes open/closed file views and Analysis/Caption references after each committed filesystem deletion, including dependent source/edited identities. It clears affected Explorer selection and clipboard entries immediately, so a later batch failure does not retain the already deleted files in those views.
- deleteExplorerEntry invokes its completion callback only after the primary removal, including when optional sidecar cleanup then fails. That failure explicitly reports that the entry was deleted. Dataset view cleanup also uses the committed-deletion callback.
- Tests deny primary removal (no callback, original remains), deny metadata cleanup (one callback, main file absent), and allow both (one callback). Scope tests remove the last selected file without widening to project scope, clear nested Caption references and preserve unrelated folder prefixes/views.
- UI-workflows, project-types and production build pass. These deletion failures use in-memory filesystem handles; native UI permission behavior and scoped-image browser checks are still pending. Browser verification remains unavailable after the previously reported automatic approval usage-limit rejection.

## Unified workspace persistence — 2026-10-09

- A version-2 storage envelope now contains workspace tab/activity metadata and the parsed dock layout. App owns a single debounced write plus pagehide flush; useDockWorkspace no longer writes an independent key. Existing tab serialization still excludes live files, handles and selection Blobs.
- Reads prefer the canonical envelope and otherwise use the prior workspace/docking keys as migration inputs. Those legacy keys remain untouched. A newer version is not overwritten, and a failed setItem leaves the old complete snapshot intact.
- Workspace-layout tests cover both legacy inputs, combined output, canonical precedence over stale legacy data, simulated quota failure, preservation of a future version and malformed JSON fallback. Workspace-layout, UI-workflows, production build and diff whitespace checks passed.
- Browser reload, pagehide timing, project reopen and floating-layout restoration remain unverified for this change. Browser tooling is still unavailable under the previously reported automatic approval usage-limit rejection; no alternative browser transport was used.

### Connected-project snapshots

- The same versioned envelope retains workspace/dock snapshots by project id. Only a connected project updates its entry; a temporary workspace cannot overwrite deferred project geometry. Initial migration retains the previous project's snapshot before writing temporary state.
- App flushes the pending snapshot before switching project sessions, then reads that project's saved tabs, dock and Explorer/Versions activity. Existing file-Blob and permission limitations are unchanged.
- Workspace-layout tests save A, save B with different views, then write a temporary workspace. They verify A is unchanged, B retains its own view layout, and initial legacy migration retains the prior project. Production build and diff checks pass. Actual project switching/reload remains a browser acceptance check, currently unavailable under the approval-review usage limit.

## Video and file Photopea renderer integration — 2026-10-09

- WorkspaceTool now creates VideoFramesTool for project/file contexts and PhotopeaBlobViewer for file-edit contexts. Video keeps the existing view id, directory, file/name and saved-frame indexing callback. File Photopea receives its existing Blob/name and required PSD-save callback. App no longer directly creates these tool instances; ordinary InternalFileViewer behavior is unchanged.
- Production build, video-frames suite, UI-workflows suite and whitespace checks passed. Video tests include cancellation, frame selection, safe writes and bounded streaming; they do not mount the refactored UI. Existing live iframe checks predate this extraction. Moving live video/Photopea views after this change remains unverified because browser access is still denied by automatic approval review's usage limit.

## Inspector simplification — 2026-10-09

- Removed the repeated Dataset Context/Assets/Supported panel and duplicate Filename property. File metadata, caption contents, Dataset trigger/overwrite controls and missing-source warning remain.
- Selection-scoped tool views now show their count, including zero; their optional Details identify Selection instead of Project. File Analysis Details identify Analysis instead of Open file. Inspector rename input and trigger field have accessible labels.
- Replaced the unused multi-metric Dataset summary calculation with the missing-source count actually displayed. Removed two empty conditional sections.
- Production build and whitespace checks passed. No new implementation-mirroring tests were added for these reversible presentation changes. Visual layout, screen-reader output and keyboard focus after these changes remain unverified while browser approval review is blocked by the usage limit.

## Unavailable history entry recovery — 2026-10-09

- Extracted WorkspaceWelcome and replaced the unavailable-view toast with a persistent message in Welcome. It directs the user to open the original project and select its file/tool. Existing Open project, New project and Import/Review actions remain.
- The recovery state clears on successful project activation, successful history restoration, explicit tab activation or tool navigation. Canceling the project chooser leaves the message available.
- Production build and whitespace checks passed. This is an explicit recovery state, not automatic restoration of Blobs or filesystem permissions. Actual browser Back/Forward/reload and chooser cancellation remain unverified under the existing automatic approval usage-limit block.

## Explorer command registration — 2026-10-09

- Copy, Cut, Paste, Duplicate, Rename, Delete and Select all in folder now use CommandProvider registrations with an Explorer DOM scope. Their old window-keydown branches were removed; tree navigation remains local. Commands appear in the palette/shortcut editor with Explorer labels, disabled conditions and reasons, and use the existing file handlers and delete confirmation.
- The common dispatcher supplies editable-field, IME, held-key, open-dialog/menu and busy-workspace protections. Project operations disable these commands together with the other workspace commands.
- Production build, UI-workflows and diff whitespace checks passed. These tests cover the command registry and shortcut utilities; they do not prove the new Explorer registrations in a live browser. Previous F2/selection browser evidence predates this dispatcher change. Browser regression checks remain blocked by automatic approval review's usage limit.

## Fallback move removal failures — 2026-10-09

- If fallback copy/delete cannot remove a file and the original still exists, it rolls back the new copy/sidecar. For a folder or an unverifiable source, it retains the complete copied destination and reports both recovery paths. It does not delete that copy after a potentially partial recursive removal or report the move as successful.
- A provider error followed by confirmed source absence is treated as committed so references can follow the destination. This branch is code-reviewed; the new tests focus on surviving originals and partial folder removal.
- The regression fixture rejects file removal and verifies original contents plus destination cleanup; its folder case removes a child before rejecting and verifies the complete destination copy remains while no move callback runs. A separate fixture emulates native TypeMismatchError for an existing directory and verifies unique-name generation uses the next suffix.
- Project-types and production build pass. Native permission handling and manual recovery UX remain unverified; automatic folder merging/rollback is not implemented. Existing browser approval-review usage restriction remains in force.


### Explicit scope browser checks — 2026-10-10

- Browser access is restored. Mounted the real WorkspaceTool with a generated PNG through tests/scope-browser.html.
- Caption: entire project shows one file; explicit empty selection shows zero files, no gallery assets, and disabled batch actions. The current-scope intersection prevents retained gallery snapshots from targeting old assets.
- Analysis: explicit empty selection shows only “No selected files to analyze”, without phantom metrics or candidates.
- Found that Analysis ignored datasetId and always used the stored Dataset. Restricted Dataset scope to an explicitly matching datasetId. Returning to entire project now visibly shows Project Analysis and Analysis-ready 1.
- UI workflow regression suite and the build passed before the datasetId correction; the separate production build after the datasetId correction also passed. These observations do not validate native permissions, full model workflows, or simultaneous dock editors.


### Workspace restore follow-up — 2026-10-10

- In the actual app, selected Import, reloaded the page, and observed Import still active with Review/Analysis/Export tabs present. The existing floating Project/Inspector/Dataset groups remained floating in the accessibility tree.
- Opened Export after reload, used browser Back to Import and Forward to Export; the URL, visible editor, active tab and Inspector title agreed. This covers tool navigation, not file recovery or project A/B switching.
- Code review found that activateProjectDirectory loaded the new store but then validated restored Dataset tabs against globalDataset captured by the previous render. applyWorkspaceTabsForProject now takes the incoming ProjectState and validates against its Dataset directly. End-to-end A/B switching remains unverified.
- Workspace layout regression tests passed.


### File navigation and Explorer commands — 2026-10-10

Actual App mounted by explorer-browser.html against disposable OPFS files:
- Opened alpha.txt with Enter. Browser Back returned to Export; Forward restored the same file editor and visible “Fixture alpha.txt” content.
- F2 opened the rename field; Escape returned focus to the original Explorer row after the command-registry integration.
- Reloaded while file history was active, then mounted a fresh fixture. The unavailable editor produced the persistent recovery message and Open project/New project/Review files actions. No stale file contents were shown. This harness creates a new fixture after reload; it does not prove reopening the same native directory.
- Explorer Copy and Paste executed through the command palette. Paste was initially disabled, became enabled after Copy, and created alpha 2.txt without replacing alpha.txt. Opening the copy displayed the original file text.
- Direct Ctrl+C/Ctrl+V is NOT accepted as passed: browser automation intercepted clipboard handling and rejected paste because its virtual clipboard was empty. Palette execution verifies application commands but not those native key combinations.


### Project activation A → B → A → B — 2026-10-10

Added project-switch-browser.html/tsx: creates two isolated OPFS project folders and substitutes only showDirectoryPicker. The actual App File → Open Project Directory code performs reads, save flushing, project activation, indexing and workspace restoration.

Observed A with Dataset A active, B with Export active, then A restored its Dataset tab and A.txt; returning to B restored Export and B.txt without Dataset A's tab. Project names, Dataset panel and active Inspector context matched each project. This validates application-level switching with real browser filesystem writes. It does not test native picker permission prompts, revoke/regrant, geometry changes between projects, or reload of those same folders.


### Accessible tool settings — 2026-10-10

Analysis settings had disconnected labels and unnamed sliders/selects. Added instance-specific useId label associations for Similarity, Sort, Filter and Overused threshold, with percentage value text for sliders. Caption Threshold and Max tags now have connected labels; the blacklist input has the accessible name Tags to block.

Browser check with scope-browser.html: the accessibility tree names Similarity, Sort and Filter. Clicking the Similarity label focused its slider, and Right increased 94% to 95%. Production build and whitespace checks passed. These checks do not substitute for an actual screen-reader session; Caption dialog controls were inspected in code but not exercised in this browser pass.


### Consistent gallery names — 2026-10-10

Added getWorkspaceDisplayName for presentation only: nonblank originalFileName, otherwise fileName. AssetGallery names/sorting/preview, WorkspacePreviewCard and Caption fields use it. Search still matches both stored and original names. Storage/export names are unchanged. Browser fixture now exposes scope-sentinel.png consistently for the group, selection checkbox, preview/open buttons, image, tags input and preview dialog title. Build passed; whitespace check passed.


### Preview across pagination — 2026-10-10

Added “Load 101 assets” to ui-browser.html's harness. With the real AssetGallery: opened Photo 99.png (100/101), pressed Right to Photo 100.png (101/101), then Escape. Gallery displayed page 2/2 and focused Photo 100.png. Enter → Left → Escape returned to page 1/2 with focus on Photo 99.png. Both transitions preserved a usable keyboard position. Shared synthetic previews isolate navigation; this is not evidence of real-image decoding performance. No production change was needed for this scenario.


### Caption batch overwrite and history — 2026-10-10

Added caption-browser.html/tsx mounting the actual App with two generated PNGs carrying different initial captions. Through the normal palette opened Caption, entered Ukrainian text “оновлено”, selected Overwrite and observed “Replace 2 captions” before submitting. Both cards changed; one palette Undo (“Edit 2 captions”) restored original-first and original-second respectively. Redo reapplied the replacement to both. This checks temporary-workspace state, not native disk persistence.

CaptionScopeControls now uses a per-instance datalist ID instead of selected-tag-suggestions shared by every editor, avoiding cross-editor suggestion binding. Production build and whitespace checks passed.


### Caption suggestion ownership — 2026-10-10

Code review found per-card suggestion IDs derived only from the asset ID, colliding when the same asset appears in multiple editors. Each TaggingCard now owns a React useId prefix for its list and options. aria-controls is present only while the list is mounted; the input exposes combobox semantics. Down from the input enters the first suggestion; Up enters the last. Escape closes suggestions and retains/restores input focus rather than blurring into the document. Production build passed. Keyboard behavior with an actual loaded CSV still requires browser verification; no such pass is claimed here.


### Live CSV suggestions and settings entry — 2026-10-11

Found Caption Settings had no remaining opener. Restored a Caption settings toolbar button and replaced the global modal flag with per-TaggingTool state, so opening one editor's settings does not open all mounted Caption dialogs. Build log confirms the production build completed successfully.

On the isolated localhost origin, loaded /tmp/caption-suggestions.csv through the real Load CSV file chooser (alpha, alpine, amber). The dialog reported three suggestions. For first.png, entered “a”: Down focused alpha, Escape closed the list and retained the input, Up focused amber, and Enter added amber while preserving original-first and returning focus to the cleared input. DOM focus inspection corroborated the active option when the accessibility snapshot lagged an animation frame. This validates manual CSV suggestions; ONNX inference and simultaneous Caption editors still need their own verification.


### Manual CSV versus model configuration — 2026-10-11

Removed manual suggestion loading's writes to workspaceSettings.localTaggerTagsPath and deletion of the saved tags file handle. Manual dictionaries now update only that editor's suggestion list/name. The empty dictionary label no longer implies a saved model path is a loaded manual dictionary.

Browser: before loading manual-suggestions.csv, model Settings tags displayed caption-suggestions.csv. After choosing the new CSV through Load CSV, Manual Tag Suggestions displayed manual-suggestions.csv — 2 suggestions while model Settings tags remained caption-suggestions.csv. Build and whitespace checks passed. This verifies visible configuration separation; there was no actual ONNX model or persisted native tags handle in this fixture.


### Analysis visual hierarchy — 2026-10-11

Removed duplicated Target block, orientation counters in controls, and the five-card metric strip. Overview retains one Review Summary including total similar groups. Context and similarity explanations are collapsed details. Production build passed; browser accessibility tree confirmed the single summary and collapsed explanations. Full responsive/theme visual inspection remains outstanding.


### Photopea save serialization — 2026-10-11

Code audit found the PSD save callback was the last UI-level filesystem writer outside the project save lane. PSD overwrite, conversion to PSD and Save Copy now run through `runProjectFileOperation`, so pending project state is flushed before the document write and later saves cannot overlap it. A failed writable is aborted when the browser supports abort. Preview cache writes remain in the same exclusive operation; Explorer and open-tab state update only after it succeeds. Production build, UI workflow tests and whitespace checks passed.


### Live PSD → PNG export — 2026-10-11

Created a 32×24 PSD fixture with red and blue halves, referenced it from a Dataset, and ran the real ExportTool with Folder destination. The normal Photopea conversion completed and wrote `sentinel.png` plus `sentinel.txt` to a fresh OPFS directory. Reopening the persisted result verified the PNG signature, 32×24 dimensions, left pixel `255,0,0,255`, right pixel `0,0,255,255`, and caption `sentinel\n`. This closes the live PSD conversion gap for folder export; the protocol/cancellation suite already covers cancellation and ZIP/folder plan parity.
