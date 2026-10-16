# Changes

## 1.0.0 (October 2026)

The first public release. Compared with the last private build, it includes the fixes from an independent code review.

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
* **Column and table image configurations are skipped without a note** when Dataverse refuses them with its own
  security error (0x80040256). In some environments it refuses them that way even to System Administrators who hold
  the privileges it names, so the "Not checked" note named them in every scan. A role that really lacks those
  privileges is still told, any other type your role cannot read is still named, and the image configurations are
  still checked wherever Dataverse allows it.

**The details and the comparison of layers**

* **The Layers tab shows when the unmanaged layer was last changed, and by whom.** Dataverse gives an unmanaged layer
  no overwrite time, so its row showed a dash. It now shows the component's last save (*Last changed*) and, for
  most components (views, charts, processes, web resources, templates, environment variables, roles and others), the user who saved it (*Last changed by &lt;name&gt;*), or for a form its last publish
  (*Last published*), taken from the layer's own data. Forms, tables, columns and relationships record no user, and
  relationships no date.
* **The comparison is lossless.** XML is laid out by changing only the spacing between elements: text, mixed content,
  `xml:space="preserve"`, single spaces between elements and the XML declaration are kept, and XML with a DOCTYPE is
  shown as stored. JSON is indented without being parsed again, so large numbers and the order of keys stay exact.
* **Numbers are kept as written.** Every number in layer data that JavaScript cannot hold exactly as written (a whole
  number above 2^53, as in a relationship's cascade mask; a long fraction; an exponent such as `1e2`; or `1.0`) keeps
  its digits, so it is shown, copied and compared exactly. A number and a text with the same digits are told apart:
  when two values differ only in type, both are shown as JSON, so the text has its quotes.
* Two different values that would look the same once laid out are shown as stored, with a note, so the difference is
  always visible. A difference in line endings alone is named, and carriage returns are shown.
* **Copy copies the value as stored** (web resource content decoded), not the laid-out text, so it can be pasted back
  exactly.
* **Every compared value has Copy.** Short values (one line, up to 200 characters) have a "Copy" link at the end of
  each layer's row.
* **Web resources whose content Dataverse keeps as a file.** A layer's data then holds `contentfileref`, a reference
  to that layer's own file, instead of `content`, and the Web API gives out only the file in effect now. The layers
  of one web resource can hold the content in different ways: in tests, right after a save through the Web API, the
  Active layer held the content itself and the managed layer only a file reference. The content is now one row,
  `content`, whichever way each layer holds it. The details read the web resource's current content once when they
  open, and the top layer, when its file is the one in effect, gets that content. When both layers' content can be read, it is
  compared like any other value (decoded, XML types laid out, images shown, with Copy), and the same content held in
  different ways is *Same*. When a layer's file is any other, its content can't be read: the row says which layer's
  content can't be read and why, shows the other layer's content with Copy, and nothing is guessed or compared line by
  line. When neither layer's content can be read, it says so.
* "1 line differs" instead of "1 line differ".

**Deleting**

* **The check after each removal compares what the managed layers define**: their solution, order and publisher, and
  the values each one sets (values Dataverse keeps up to date itself, such as the overwrite time, are left out). When
  the unmanaged layer is gone but a managed layer's values changed at the same time (another import, for example), the
  row says "Result unknown" with the reason, instead of "Deleted". A relationship in that case is no longer reported as
  "Partly deleted".
* **The deletion log holds a web resource's content also when Dataverse keeps it as a file.** Right before the
  removal, the web resource's current content is read (one extra read per such component). When its file is the
  unmanaged layer's, the log entry holds it as `content` (base64, as Dataverse stores it); otherwise the entry has
  `contentNote`: "the content of the unmanaged layer could not be read before the removal". When the unmanaged layer
  holds the content itself, its changes already contain it.

**Building and settings**

* No environment names are built in any more. Development environments (where deleting is turned off) and production
  environments (named in red in the delete confirmation) can be named in an optional local `scanner.settings.json`,
  read at build time and never published. See `scanner.settings.example.json` and the README.
* **The settings are checked.** `scanner.settings.json` must be a JSON object, and a setting name other than
  `developmentEnvironments` and `productionEnvironments` stops the build ("scanner.settings.json: unknown setting ...
  The settings are: developmentEnvironments, productionEnvironments."), so a misspelled name can no longer leave
  deleting allowed in a development environment. The build prints the rules it applied ("Built with your environment
  rules from scanner.settings.json (developmentEnvironments /.../i): for your organization only, do not publish this
  build."), and a file without rules prints "scanner.settings.json names no environment: built without environment
  rules."
* **`package-lock.json` is published** (terser 5.51.2 and its dependencies, 11 packages), so `npm ci` works and
  installs exactly what built the release. Use it for release builds.
* The version is shown in the window's title tooltip and on the install page, from `package.json`.
* The PowerShell version for pipelines was removed; the bookmarklet is the only tool.

## Before the public release

The scanner was built and used privately before 1.0.0. What those builds added, newest first:

### Column widths

* Columns can be resized by dragging their header edges; a double-click or **Fit to contents** fits a column to its
  values; widths are remembered; **Reset column widths**.
* **What changed** shows as many property names as fit in the column, then +N.

### Type bubbles and layer pickers

* The type bubbles came back (with a **More (n)** menu for those that do not fit), as the Type column's filter.
* The layer pickers in the comparison never offer the same layer on both sides; **Swap**.
* The object types card comes before the tables card.
* Deleting follows the order shown, top to bottom; the confirmation lists the components in that order.

### Tables, filters and details

* **Limit to tables**: check only the components of the tables you choose.
* Every column of the results filters and sorts like Excel (values with counts, search, Select all).
* **Details** for each component: compare any two layers property by property (XML and JSON laid out, web resource
  content decoded, images shown, side by side or inline), the list of layers, and each layer's Changes, All properties
  and Children.
* The window can be moved, resized and maximized, and remembers its place.
* A component type the user's security role cannot read is named in a note ("Not checked") instead of making the scan
  incomplete.

### One confirmation and a new design

* Deleting needs one confirmation, as **Remove active customizations** in the maker portal, with the checks before and
  after each component kept.
* A row's link opens the component's solution layers in the managed solution it was found in.
* The window was redesigned (Fluent 2), with no layout jumps while loading.

### The maker portal, object types and saved selections

* Runs on the environment's Solutions pages in the maker portal (make.powerapps.com), with the portal's own sign-in.
* Choose object types (for example only forms and views).
* Saved selections.
* A click on a row opens the component's solution layers page; the type tags filter the results.

### Choosing the managed solutions

* Choose the managed solutions to check before the scan; each result names its managed solution.
* Solution membership is read by id for the components found, so the cost follows the number of findings.

### The first builds

* The scan: one query per component type for managed components whose top layer is unmanaged, the solution summary
  for the types the sweep cannot read, and the layers of each finding.
* Deleting with checks before and after each component.
