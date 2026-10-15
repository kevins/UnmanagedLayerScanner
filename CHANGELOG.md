# Changes

## 6.3.0 (October 2026)

The first public release. It includes the fixes from an independent code review.

**Scanning**

* **Stop always stops.** Stop now ends the reads that are waiting or in progress at once, instead of waiting for a slow
  or stalled answer, and a scan started right after a stop no longer waits for the reads of the one before.
* **A read that gets no full answer within 5 minutes ends** (it is not sent again, so a heavy query does not load the
  server twice). Before, a stalled answer could leave the window in "Stopping…" until the page was reloaded.
* **Components flagged only by the solution summary are confirmed before they are listed.** The summary also flags a
  table when only one of its parts is customized. Their layers are now read first, up to 1,000 of them, whatever the
  details setting, and the ones without an unmanaged layer of their own are dropped. Before, past the first 500
  findings, such a table could be listed although it had no unmanaged layer.
* **Incomplete scans say so in more cases.** A component with an unmanaged layer that is in no solution's component
  list and whose layers cannot be read (or more than 1,000 such components), and a summary-only component whose layers
  cannot be read, now mark the scan INCOMPLETE and are named in the details, instead of only a note.
* The banner about details not read yet counts the components whose details were read, and says when some of the
  others were flagged only by the solution summary. "Read N more" reads those first.

**The details and the comparison of layers**

* **The comparison is lossless.** XML is laid out by changing only the spacing between elements: text, mixed content,
  `xml:space="preserve"`, single spaces between elements and the XML declaration are kept, and XML with a DOCTYPE is
  shown as stored. JSON is indented without being parsed again, so large numbers and the order of keys stay exact.
  Whole numbers above 2^53 in layer data (such as a relationship's cascade mask) keep their exact digits.
* Two different values that would look the same once laid out are shown as stored, with a note, so the difference is
  always visible. A difference in line endings alone is named, and carriage returns are shown.
* **Copy copies the value as stored** (web resource content decoded), not the laid-out text, so it can be pasted back
  exactly.
* "1 line differs" instead of "1 line differ".

**Deleting**

* **The check after each removal compares what the managed layers define**: their solution, order and publisher, and
  the values each one sets (values Dataverse keeps up to date itself, such as the overwrite time, are left out). When
  the unmanaged layer is gone but a managed layer's values changed at the same time (another import, for example), the
  row says "Result unknown" with the reason, instead of "Deleted". A relationship in that case is no longer reported as
  "Partly deleted".

**Building and settings**

* No environment names are built in any more. Development environments (where deleting is turned off) and production
  environments (named in red in the delete confirmation) can be named in an optional local `scanner.settings.json`,
  read at build time and never published. See `scanner.settings.example.json` and the README.
* The version is shown in the window's title tooltip and on the install page, from `package.json`.
* The PowerShell version for pipelines was removed; the bookmarklet is the only tool.

## 6.2

* Columns can be resized by dragging their header edges; a double-click or **Fit to contents** fits a column to its
  values; widths are remembered; **Reset column widths**.
* **What changed** shows as many property names as fit in the column, then +N.

## 6.1

* The type bubbles came back (with a **More (n)** menu for those that do not fit), as the Type column's filter.
* The layer pickers in the comparison never offer the same layer on both sides; **Swap**.
* The object types card comes before the tables card.
* Deleting follows the order shown, top to bottom; the confirmation lists the components in that order.

## 6.0

* **Limit to tables**: check only the components of the tables you choose.
* Every column of the results filters and sorts like Excel (values with counts, search, Select all).
* **Details** for each component: compare any two layers property by property (XML and JSON laid out, web resource
  content decoded, images shown, side by side or inline), the list of layers, and each layer's Changes, All properties
  and Children.
* The window can be moved, resized and maximized, and remembers its place.
* A component type the user's security role cannot read is named in a note ("Not checked") instead of making the scan
  incomplete.

## 5.0

* Deleting needs one confirmation, as **Remove active customizations** in the maker portal, with the checks before and
  after each component kept.
* A row's link opens the component's solution layers in the managed solution it was found in.
* The window was redesigned (Fluent 2), with no layout jumps while loading.

## 4.0

* Runs on the environment's Solutions pages in the maker portal (make.powerapps.com), with the portal's own sign-in.
* Choose object types (for example only forms and views).
* Saved selections.
* A click on a row opens the component's solution layers page; the type tags filter the results.

## 3.0

* Choose the managed solutions to check before the scan; each result names its managed solution.
* Solution membership is read by id for the components found, so the cost follows the number of findings.

## 2.0 and 1.0

* The scan: one query per component type for managed components whose top layer is unmanaged, the solution summary
  for the types the sweep cannot read, and the layers of each finding.
* Deleting with checks before and after each component.
