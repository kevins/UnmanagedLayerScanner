// Unmanaged layer scanner: for the managed solutions you choose, finds every component that has an unmanaged
// (Active) layer on top, and can remove those layers. Runs as a bookmarklet with the signed-in user's own session,
// on a page of the environment (https://<org>.crm.dynamics.com/...) or on the environment's pages in the maker
// portal (https://make.powerapps.com/environments/<id>/solutions...).
//
// Safety rules built in:
//   - The scan only reads. Every request that changes something goes through write(), which refuses to run
//     unless a removal was confirmed in the removal window (armed).
//   - Deleting is one confirmation, as "Remove active customizations" in the maker portal, for the ticked components
//     (the confirmation lists them all, also those hidden by a filter). It is turned off in development environments.
//   - Only the unmanaged layer is removed (RemoveActiveCustomizations, as Solution Layers Explorer does), one component
//     at a time. Right before each removal its layers are read again (a component with no managed layer underneath is
//     never touched); afterwards the unmanaged layer must be gone and the managed layers identical to before.
(async () => {
  'use strict'
  // Where it runs: a page of the environment itself, or the maker portal (make.powerapps.com) with an environment open.
  const ON_MAKER = /^make\.(preview\.)?powerapps\.com$/i.test(location.hostname)
  const envOfUrl = () => ((/\/environments\/([0-9a-z-]+)/i.exec(location.pathname) || [])[1] || '').toLowerCase()
  const KEY = ON_MAKER ? 'maker|' + envOfUrl() : location.hostname
  const old = window.__layerScanner
  if (old) {
    if (typeof old.destroy !== 'function') { alert('An older version of the scanner is open on this page. Reload the page, then click the bookmark again.'); return }
    if (old.starting) { alert('The scanner is still starting. Wait a moment.'); return }
    if (old.key === KEY && old.ready()) { old.show(); return }
    // Another environment (the maker portal changes environment without reloading the page), or a start that failed:
    // start again.
    if (!old.destroy()) { alert('The scanner is still working. Wait until it has finished, then click the bookmark again.'); return }
  }
  if (!ON_MAKER && !/\.dynamics\.com$/i.test(location.hostname)) { alert('Open the environment (https://<org>.crm.dynamics.com) or its Solutions page in the maker portal (make.powerapps.com) first, then click the bookmark again.'); return }
  if (ON_MAKER && !envOfUrl()) { alert('Open an environment in the maker portal (for example its Solutions page), then click the bookmark again.'); return }
  const placeholder = { key: KEY, starting: true }   // a second click while connecting does not start a second scanner
  window.__layerScanner = placeholder
  const giveUp = (msg) => { if (window.__layerScanner === placeholder) delete window.__layerScanner; alert(msg) }
  let conn
  try { conn = ON_MAKER ? await connectMaker(envOfUrl()) : { origin: location.origin, envId: '', host: location.hostname, account: '' } } catch (e) { giveUp(e.message); return }
  if (conn.error) { giveUp(conn.error); return }
  if (ON_MAKER && envOfUrl() !== conn.envId) { giveUp('The maker portal moved to another environment while the scanner was starting. Click the bookmark again.'); return }

  // ------------------------------------------------------------------ sign-in on the maker portal
  // On make.powerapps.com the page has no session with the environment. The maker portal keeps its own Dataverse
  // sign-in (an access token) in this browser's local storage and renews it while the portal is used. The scanner
  // borrows that token for this one environment only: it reads it for each request, sends it only to that
  // environment's address, and never stores, shows or exports it.
  function accessTokenEntries() {
    const out = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || ''
      if (!/\|accesstoken\|/i.test(k)) continue
      try { const e = JSON.parse(localStorage.getItem(k)); if (e && e.secret && String(e.credentialType).toLowerCase() === 'accesstoken') out.push(e) } catch { }
    }
    return out
  }
  function scopesOf(e) { return String(e.target || '').toLowerCase().split(' ') }
  // The token for a host, of one signed-in account (the one the environment was confirmed with), never another's.
  function makerToken(host, account) {
    let best = null
    for (const e of accessTokenEntries()) if (String(e.homeAccountId) === account && scopesOf(e).some((t) => t.startsWith(`https://${host}/`)) && (!best || Number(e.expiresOn) > Number(best.expiresOn))) best = e
    return best && { token: best.secret, secondsLeft: Number(best.expiresOn) - Math.floor(Date.now() / 1000) }
  }
  // The account the maker portal is using for a host: the only account with a token for it, or MSAL's active account.
  // { account, ambiguous }: ambiguous when several accounts have one and none is marked active.
  function makerAccount(host) {
    const accounts = [...new Set(accessTokenEntries().filter((e) => scopesOf(e).some((t) => t.startsWith(`https://${host}/`))).map((e) => String(e.homeAccountId)))]
    if (accounts.length <= 1) return { account: accounts[0] || '', ambiguous: false }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || ''
      if (!/active-account/i.test(k)) continue
      try { const a = JSON.parse(localStorage.getItem(k)); if (a && accounts.includes(String(a.homeAccountId))) return { account: String(a.homeAccountId), ambiguous: false } } catch { }
    }
    return { account: accounts[0], ambiguous: true }
  }
  // The environment's Dataverse address: every address the portal holds a token for is asked for its environment id,
  // and only the one whose id is the id in the page address is used (the browser can hold tokens for several).
  async function connectMaker(envId) {
    const hosts = new Set()
    for (const e of accessTokenEntries()) for (const t of scopesOf(e)) { const m = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.dynamics\.com)\//.exec(t); if (m) hosts.add(m[1]) }
    // Try first the addresses this page has called most recently (the open environment's), so other environments are
    // asked only when needed (a read of their id, with their own token).
    const last = new Map()
    for (const r of performance.getEntriesByType('resource')) { try { const h = new URL(r.name).hostname.toLowerCase(); last.set(h, Math.max(last.get(h) || 0, r.startTime + 1)) } catch { } }
    for (const host of [...hosts].sort((a, b) => (last.get(b) || 0) - (last.get(a) || 0))) {
      const { account, ambiguous } = makerAccount(host)
      const t = makerToken(host, account)
      if (!t || t.secondsLeft < 120) continue
      try {
        const r = await fetch(`https://${host}/api/data/v9.2/RetrieveCurrentOrganization(AccessType=Microsoft.Dynamics.CRM.EndpointAccessType'Default')`,
          { credentials: 'omit', redirect: 'manual', headers: { Accept: 'application/json', Authorization: 'Bearer ' + t.token }, signal: AbortSignal.timeout(30000) })
        if (!r.ok) continue
        const d = (await r.json()).Detail
        if (d && String(d.EnvironmentId).toLowerCase() === envId) {
          if (ambiguous) return { error: 'This browser holds the maker portal sign-in of more than one account for this environment, and the scanner cannot tell which one you are using. Sign out of the other account (or use a separate browser profile), reload the page, then click the bookmark again.' }
          return { origin: `https://${host}`, envId, host, account }
        }
      } catch { }
    }
    throw new Error("The maker portal has no current sign-in to this environment's data. Wait until the Solutions list has loaded (or reload the page), then click the bookmark again.")
  }

  // ------------------------------------------------------------------ settings
  const CONFIG = {
    // Optional environment rules, set at build time from scanner.settings.json (see the README); none by default.
    // Each is a regular expression matched against the environment's name, the first part of its address.
    developmentEnvironments: null,                  // deleting is never offered there
    productionEnvironments: null,                   // the delete confirmation names them as production, in red
    maxRemovePerRun: 100,                           // larger clean-ups go in several runs
    autoDetails: 500,                               // details are read automatically for this many findings; the rest on request
    maxRows: 2000,                                  // rows drawn in the table (filter to see others)
    concurrency: 4,                                 // requests in flight at once (Dataverse allows 52 per user)
    detailConcurrency: 3,
    pageSize: 5000,                                 // rows per page (Dataverse maximum); smaller only for tests
    deleteConcurrency: 1,                           // one component at a time, as Solution Layers Explorer does (Dataverse does
                                                    // the removals one after the other anyway, about 8 s each)
    layerCheckLimit: 1000,                          // components not in the solutions' component lists whose layers are read to place them,
                                                    // and components flagged only by the solution summary whose layers are read to confirm them
    readTimeout: 300000,                            // a read with no full answer after 5 minutes is ended, not sent again
  }
  const VERSION = '__VERSION__'   // set by build-bookmarklet.mjs from package.json
  const ORIGIN = conn.origin
  const API = ORIGIN + '/api/data/v9.2/'
  const ACTIVE = 'fd140aae-4df4-11dd-bd17-0019b9312238'    // the unmanaged ("Active") layer, same id everywhere
  const DEFAULT = 'fd140aaf-4df4-11dd-bd17-0019b9312238'
  const ORG = new URL(ORIGIN).hostname.split('.')[0]
  const MAKER = ON_MAKER ? location.origin : 'https://make.powerapps.com'   // the maker portal, for the links to each component's layers
  const IS_DEV = !!CONFIG.developmentEnvironments && CONFIG.developmentEnvironments.test(ORG), IS_PROD = !!CONFIG.productionEnvironments && CONFIG.productionEnvironments.test(ORG)

  // Classic component types: the table behind each, the name the layer table uses, and the name the maker portal shows.
  const CLASSIC = {
    1: ['entity', 'Entity', 'Table'], 2: ['attribute', 'Attribute', 'Column'], 9: ['', 'OptionSet', 'Choice'], 10: ['relationship', 'EntityRelationship', 'Relationship'],
    14: ['entitykey', 'EntityKey', 'Key'], 20: ['role', 'Role', 'Security role'], 22: ['displaystring', 'DisplayString', 'Display string'],
    26: ['savedquery', 'SavedQuery', 'View'], 29: ['workflow', 'Workflow', 'Process'], 31: ['report', 'Report', 'Report'], 36: ['template', 'Template', 'Email template'],
    39: ['mailmergetemplate', 'MailMergeTemplate', 'Mail merge template'], 44: ['duplicaterule', 'DuplicateRule', 'Duplicate detection rule'],
    45: ['duplicaterulecondition', 'DuplicateRuleCondition', 'Duplicate detection rule condition'], 46: ['entitymap', 'EntityMap', 'Table mapping'],
    47: ['attributemap', 'AttributeMap', 'Column mapping'], 50: ['ribboncustomization', 'RibbonCustomization', 'Ribbon customization'],
    59: ['savedqueryvisualization', 'SavedQueryVisualization', 'Chart'], 60: ['systemform', 'SystemForm', 'Form'], 61: ['webresource', 'WebResource', 'Web resource'],
    62: ['sitemap', 'SiteMap', 'Site map'], 63: ['connectionrole', 'ConnectionRole', 'Connection role'], 65: ['hierarchyrule', 'HierarchyRule', 'Hierarchy rule'],
    66: ['customcontrol', 'CustomControl', 'Custom control'], 68: ['customcontroldefaultconfig', 'CustomControlDefaultConfig', 'Custom control default configuration'],
    70: ['fieldsecurityprofile', 'FieldSecurityProfile', 'Field security profile'], 71: ['fieldpermission', 'FieldPermission', 'Field permission'],
    80: ['appmodule', 'AppModule', 'Model-driven app'], 90: ['plugintype', 'PluginType', 'Plug-in type'], 91: ['pluginassembly', 'PluginAssembly', 'Plug-in assembly'],
    92: ['sdkmessageprocessingstep', 'SdkMessageProcessingStep', 'Plug-in step'], 93: ['sdkmessageprocessingstepimage', 'SdkMessageProcessingStepImage', 'Plug-in step image'],
    95: ['serviceendpoint', 'ServiceEndpoint', 'Service endpoint'], 150: ['routingrule', 'RoutingRule', 'Routing rule'], 151: ['routingruleitem', 'RoutingRuleItem', 'Routing rule item'],
    152: ['sla', 'SLA', 'SLA'], 153: ['slaitem', 'SLAItem', 'SLA item'], 154: ['convertrule', 'ConvertRule', 'Record creation rule'], 155: ['convertruleitem', 'ConvertRuleItem', 'Record creation rule item'],
    161: ['mobileofflineprofile', 'MobileOfflineProfile', 'Mobile offline profile'], 162: ['mobileofflineprofileitem', 'MobileOfflineProfileItem', 'Mobile offline profile item'],
    208: ['importmap', 'ImportMap', 'Import map'], 210: ['webwizard', 'WebWizard', 'Web wizard'], 300: ['canvasapp', 'CanvasApp', 'Canvas app'],
    380: ['environmentvariabledefinition', 'EnvironmentVariableDefinition', 'Environment variable'], 381: ['environmentvariablevalue', 'EnvironmentVariableValue', 'Environment variable value'],
    430: ['entityanalyticsconfig', 'EntityAnalyticsConfiguration', 'Table analytics configuration'], 431: ['attributeimageconfig', 'AttributeImageConfiguration', 'Column image configuration'],
    432: ['entityimageconfig', 'EntityImageConfiguration', 'Table image configuration'],
  }
  const WORKFLOW_TYPE = { 0: 'Classic workflow', 1: 'Dialog', 2: 'Business rule', 3: 'Action', 4: 'Business process flow', 5: 'Cloud flow', 6: 'Desktop flow' }
  const FORM_TYPE = { 0: 'Dashboard', 2: 'Main form', 5: 'Mobile form', 6: 'Quick view form', 7: 'Quick create form', 8: 'Dialog form', 9: 'Task flow form', 10: 'Interactive dashboard', 11: 'Card form', 12: 'Main form (interactive)' }
  const VIEW_TYPE = { 0: 'Public view', 1: 'Advanced find view', 2: 'Associated view', 4: 'Quick find view', 64: 'Lookup view', 8192: 'Offline view' }
  // Columns used to show each component: [display name column, schema/unique name column]. Others use the primary name.
  const NAMES = {
    22: [null, 'displaystringkey'], 29: ['name', 'uniquename'], 36: ['title', null], 61: ['displayname', 'name'], 62: ['sitemapname', 'sitemapnameunique'],
    80: ['name', 'uniquename'], 90: ['name', 'typename'], 300: ['displayname', 'name'], 380: ['displayname', 'schemaname'], 381: ['schemaname', 'schemaname'],
  }
  const SCHEMA_GUESS = ['uniquename', 'schemaname', 'connectionreferencelogicalname']   // newer component types
  const TABLE_COLUMN = { 60: 'objecttypecode', 26: 'returnedtypecode', 59: 'primaryentitytypecode', 29: 'primaryentity', 50: 'entity' }
  const SUBTYPE_COLUMN = { 29: 'category', 60: 'type', 26: 'querytype' }
  const WANTED_COLUMNS = ['ismanaged', 'solutionid', 'name', 'displayname', 'title', 'typename', 'sitemapname', 'sitemapnameunique', 'displaystringkey', 'category', 'type', 'querytype', ...SCHEMA_GUESS]
  // Tables, columns, relationships and keys have their own component tables without an ismanaged column.
  // Relationships carry their own ids there, so they are matched to their definitions by schema name.
  const METADATA = { 1: ['entities', 'entityid', 'logicalname'], 2: ['attributes', 'attributeid', 'logicalname'], 10: ['relationships', 'relationshipid', 'name'], 14: ['entitykeys', 'entitykeyid', 'logicalname'] }
  // Rows that are not components themselves: business-unit copies of roles, activation copies of classic processes.
  const TYPE_FILTER = { 20: '_parentroleid_value eq null', 29: 'type eq 1' }
  // Parts of a table: in a solution that holds the table "with all objects", these belong to it without rows of their own.
  const TABLE_PARTS = new Set([2, 10, 14, 26, 59, 60])
  // Types that belong to a table: tables, columns, relationships, keys, views, processes, ribbons, charts, forms.
  const TABLE_BOUND = new Set([1, 2, 10, 14, 26, 29, 50, 59, 60])
  // Object types to choose from, as the maker portal groups them. Forms and processes are split by their kind.
  const GROUPS = ['Tables', 'Columns', 'Relationships', 'Keys', 'Forms', 'Views', 'Charts', 'Business rules', 'Dashboards', 'Cloud flows', 'Other processes',
    'Choices', 'Security roles', 'Column security profiles', 'Web resources', 'Environment variables', 'Connection references', 'Email templates',
    'Display strings', 'Plug-ins', 'Apps', 'Site maps', 'Reports', 'Other']
  const CODE_GROUP = { 1: 'Tables', 2: 'Columns', 10: 'Relationships', 14: 'Keys', 26: 'Views', 59: 'Charts', 9: 'Choices', 20: 'Security roles', 70: 'Column security profiles',
    71: 'Column security profiles', 61: 'Web resources', 380: 'Environment variables', 381: 'Environment variables', 36: 'Email templates', 22: 'Display strings',
    90: 'Plug-ins', 91: 'Plug-ins', 92: 'Plug-ins', 93: 'Plug-ins', 80: 'Apps', 300: 'Apps', 62: 'Site maps', 31: 'Reports' }
  const isConnRef = (kind) => /^connectionreference$/i.test(kind || '')
  function groupOf(f) {
    if (f.code === 60) return /dashboard/i.test(f.type) ? 'Dashboards' : 'Forms'
    if (f.code === 29) return f.type === 'Business rule' ? 'Business rules' : f.type === 'Cloud flow' ? 'Cloud flows' : 'Other processes'
    if (isConnRef(f.kind)) return 'Connection references'
    return CODE_GROUP[f.code] || 'Other'
  }
  // Whether a component type has to be read for the chosen groups (null: all groups).
  function typeWanted(code, kind, groups) {
    if (!groups) return true
    if (code === 60) return groups.has('Forms') || groups.has('Dashboards')
    if (code === 29) return groups.has('Business rules') || groups.has('Cloud flows') || groups.has('Other processes')
    if (isConnRef(kind)) return groups.has('Connection references')
    return groups.has(CODE_GROUP[code] || 'Other')
  }
  // A process layer holding only these properties was just switched on or off, or given a new owner.
  const STATE_ONLY = new Set(['statecode', 'statuscode', 'ownerid', 'owninguser', 'owningteam', 'owningbusinessunit', 'modifiedon', 'modifiedby',
    'modifiedonbehalfby', 'versionnumber', 'componentstate', 'overwritetime', 'solutionid', 'supportingsolutionid', 'ismanaged', 'workflowid', 'workflowidunique'])
  const MICROSOFT = /microsoft|dynamics 365/i   // publishers hidden by default in the solution list

  // ------------------------------------------------------------------ Web API
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const lc = (v) => String(v == null ? '' : v).toLowerCase()
  const label = (l) => (l && ((l.UserLocalizedLabel && l.UserLocalizedLabel.Label) || (l.LocalizedLabels && l.LocalizedLabels[0] && l.LocalizedLabels[0].Label))) || ''
  let requests = 0, pauseUntil = 0, inFlight = 0, armed = false, stopReads = false
  // Stop: the reads waiting or in flight end at once (their fetch is aborted). A removal is never aborted.
  let stopCtl = new AbortController()
  function stopAllReads() { stopReads = true; stopCtl.abort() }
  function resumeReads() { const old = stopCtl; stopCtl = new AbortController(); stopReads = false; old.abort() }   // reads of before end too
  // A wait before a read is tried again, which Stop ends early (halt: the read's stop signal). Writes wait it out.
  const pause = (ms, halt) => (!halt ? sleep(ms) : new Promise((r) => {
    if (halt.aborted) return r()
    const done = () => { clearTimeout(t); halt.removeEventListener('abort', done); r() }
    const t = setTimeout(done, ms)
    halt.addEventListener('abort', done)
  }))
  const waiting = []
  async function slot() { while (inFlight >= CONFIG.concurrency) await new Promise((r) => waiting.push(r)); inFlight++ }
  function release() { inFlight--; const w = waiting.shift(); if (w) w() }
  class SessionError extends Error {}
  class StopError extends SessionError {}   // the scan was stopped: it passes every catch, as a session error does
  const MAKER_EXPIRED = "The maker portal's sign-in to this environment has expired. Reload the page, then click the bookmark again."

  // One request. Reads retry on throttling, server and network errors; writes retry only on throttling
  // (a 5xx can arrive after the server already made the change, so the caller re-checks instead).
  let liveRequests = 0   // requests started and not finished (waiting, pausing or in flight)
  async function request(method, path, body, opts = {}) {
    liveRequests++
    try { return await requestOnce(method, path, body, opts) } finally { liveRequests-- }
  }
  async function requestOnce(method, path, body, { write = false } = {}) {
    // Only this environment's Web API, and only reads unless a confirmed removal is running.
    const u = new URL(path, API), url = u.href
    if (u.origin !== ORIGIN || !u.pathname.startsWith('/api/data/v9.2/')) throw new Error(`Blocked: ${url.slice(0, 80)} is not this environment's Web API.`)
    let all
    try { all = decodeURIComponent(u.pathname + u.search) } catch { throw new Error(`Blocked: ${url.slice(0, 80)} is not a valid address.`) }
    if (u.pathname.includes('//')) throw new Error(`Blocked: ${url.slice(0, 80)} is not a valid address.`)
    if ((method !== 'GET' || /RemoveActiveCustomization/i.test(all)) && !(write && armed)) throw new Error('Blocked: the scanner is read-only outside a confirmed removal.')
    let renewed = false
    // A read belongs to the scan running when it started: once that scan is stopped, it stays stopped.
    const halt = write ? null : stopCtl.signal, halted = () => !!halt && (halt.aborted || stopReads)
    const stop = () => new StopError('The scan was stopped.')
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (halted()) throw stop()
      while (Date.now() < pauseUntil) { await pause(pauseUntil - Date.now(), halt); if (halted()) throw stop() }
      const auth = {}
      if (ON_MAKER) {
        const t = makerToken(conn.host, conn.account)
        if (!t || t.secondsLeft < 30) throw new SessionError(MAKER_EXPIRED)
        auth.Authorization = 'Bearer ' + t.token
      }
      await slot()
      if (halted()) { release(); throw stop() }
      // A read ends when the scan is stopped, or when no full answer came within CONFIG.readTimeout (it is then not
      // sent again, so a heavy query does not load the server twice). A write is never ended early: its result is
      // checked by reading the layers again.
      const ctl = new AbortController(), onStop = () => ctl.abort()
      let late = false, res, text, netError = null
      const timer = write ? 0 : setTimeout(() => { late = true; ctl.abort() }, CONFIG.readTimeout)
      if (halt) halt.addEventListener('abort', onStop)
      try {
        requests++
        res = await fetch(url, {
          method, credentials: ON_MAKER ? 'omit' : 'same-origin', redirect: 'manual', signal: write ? undefined : ctl.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Prefer: `odata.maxpagesize=${CONFIG.pageSize}`, ...auth },
          body: body ? JSON.stringify(body) : undefined,
        })
        text = await res.text()
      } catch (e) { netError = e }
      finally { clearTimeout(timer); if (halt) halt.removeEventListener('abort', onStop); release() }
      if (halted()) throw stop()
      if (late) throw new Error(`${method} ${path.slice(0, 120)}: no answer within ${CONFIG.readTimeout / 60000} minutes`)
      if (netError) {   // network error (VPN blip, dropped connection)
        if (!write && attempt < 6) { await pause(1000 * 2 ** attempt, halt); continue }
        throw new Error(`${method} ${path.slice(0, 120)}: network error ${netError.message}`)
      }
      if (res.type === 'opaqueredirect' || res.status === 401) {
        if (ON_MAKER && !renewed) { renewed = true; attempt--; continue }   // the portal may have renewed its token meanwhile
        throw new SessionError(ON_MAKER ? MAKER_EXPIRED : 'Your session has expired. Reload the page, sign in again and click the bookmark.')
      }
      if (res.status === 429) { pauseUntil = Math.max(pauseUntil, Date.now() + 1000 * Number(res.headers.get('Retry-After') || 2 ** attempt)); if (attempt < 6) continue }
      // A 500/504 on a heavy query is usually a server timeout: try it once more only, so it does not load the server.
      if (!write && (res.status === 502 || res.status === 503) && attempt < 6) { await pause(1000 * 2 ** attempt, halt); continue }
      if (!write && (res.status === 500 || res.status === 504) && attempt < 2) { await pause(3000, halt); continue }
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { json = undefined }
      if (!res.ok) { const e = new Error(`${method} ${path.slice(0, 140)}: HTTP ${res.status} ${(json && json.error && json.error.message) || ''}`); e.status = res.status; throw e }
      if (json === undefined) throw new Error(`${method} ${path.slice(0, 120)}: the answer was not JSON (sign-in page?)`)
      return json
    }
    throw new Error(`${method} ${path.slice(0, 120)}: no answer after 6 attempts`)
  }
  const read = (path) => request('GET', path)
  const write = (method, path, body) => request(method, path, body, { write: true })
  async function getAll(path) {
    let url = path, rows = [], pages = 0
    while (url) {
      const page = await read(url)
      if (!page || !Array.isArray(page.value)) throw new Error(`Unexpected answer for ${path.slice(0, 100)}`)
      rows = rows.concat(page.value)
      url = page['@odata.nextLink'] || null
      if (++pages > 2000) throw new Error('Too many pages')
    }
    return rows
  }
  // Runs fn over the items, n at a time. The first error stops new items and is thrown when the running ones are done
  // (so their progress messages do not overwrite it).
  async function pool(items, n, fn) {
    let i = 0, failed = null
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length && !failed) { const k = i++; try { await fn(items[k], k) } catch (e) { failed = failed || e } } }))
    if (failed) throw failed
  }

  // Layers of one component, top first. ($select is honoured by some versions only; the rest is ignored.)
  // A component id and a layer name, checked before they go into an address.
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  function placeOk(id, kind) { if (!GUID.test(String(id)) || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(String(kind))) throw new Error(`Not a component id and layer name: ${String(id).slice(0, 40)} ${String(kind).slice(0, 40)}`) }
  async function getLayers(id, kind) {
    placeOk(id, kind)
    const rows = await getAll(`msdyn_componentlayers?$filter=(msdyn_componentid eq '${id}' and msdyn_solutioncomponentname eq '${kind}')&$select=msdyn_solutionname,msdyn_order,msdyn_name,msdyn_solutioncomponentname,msdyn_changes,msdyn_componentlayerid,msdyn_publishername,msdyn_overwritetime`)
    return rows.sort((a, b) => b.msdyn_order - a.msdyn_order)
  }
  const places = (f) => [...(f.alt || []), { id: f.id, kind: f.kind }]
  const managedOf = (layers) => layers.filter((l) => l.msdyn_solutionname !== 'Active').map((l) => `${l.msdyn_solutionname}#${l.msdyn_order}`)
  // The managed layers as they are defined (solution, order, publisher and the values each one sets), to check that a
  // removal left them as they were. Values Dataverse keeps up to date itself are left out (after a removal it resets
  // the overwrite time of the layer that comes on top).
  const LAYER_SYSTEM = new Set(['overwritetime', 'modifiedon', 'modifiedby', 'modifiedonbehalfby', 'versionnumber'])
  const sortedJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x))
  // Reads JSON as Dataverse wrote it: a whole number too large for JavaScript (above 2^53, such as a relationship's
  // cascade mask) keeps its exact digits, as text, so it is shown, copied and compared exactly.
  const exactNumbers = (k, v, c) => (typeof v === 'number' && !Number.isSafeInteger(v) && c && /^-?\d+$/.test(c.source) ? c.source : v)
  const managedPrint = (layers) => layers.filter((l) => l.msdyn_solutionname !== 'Active').map((l) => {
    let set = l.msdyn_changes || ''
    try { const a = JSON.parse(set, exactNumbers).Attributes; if (Array.isArray(a)) set = sortedJson(a.filter((x) => x && !LAYER_SYSTEM.has(lc(x.Key))).map((x) => [String(x.Key), x.Value]).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))) } catch { }
    return `${l.msdyn_solutionname}#${l.msdyn_order}#${l.msdyn_publishername || ''}#${set}`
  })
  function changedKeys(layer) {
    try { return (JSON.parse(layer.msdyn_changes).Attributes || []).map((a) => a && a.Key).filter((k) => typeof k === 'string') } catch { return [] }
  }

  // ------------------------------------------------------------------ managed solutions
  async function listManagedSolutions() {
    // Hidden solutions are included too: Microsoft's base solutions (System and others) are hidden, and many standard
    // tables, forms and views belong only to them.
    const rows = await getAll(`solutions?$select=solutionid,uniquename,friendlyname,version,installedon,isvisible&$filter=ismanaged eq true&$expand=publisherid($select=friendlyname,customizationprefix)`)
    return rows.map((s) => ({ id: lc(s.solutionid), unique: s.uniquename, name: s.friendlyname || s.uniquename, version: s.version, installedOn: (s.installedon || '').slice(0, 10), publisher: (s.publisherid && s.publisherid.friendlyname) || '', hidden: s.isvisible === false }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // ------------------------------------------------------------------ scan
  // solutions: the managed solutions chosen ({ id, unique, name }); allSolutions: every managed solution (read when not given)
  // objectTypes: object type groups to check (see GROUPS); empty or null: all of them.
  // tables: logical names of the tables whose components are checked; empty or null: all (and components without a table).
  async function scan(solutions, progress = () => {}, { details = true, allSolutions = null, objectTypes = null, tables: onlyTables = null } = {}) {
    const groups = objectTypes && objectTypes.length ? new Set(objectTypes) : null
    const tableSet = onlyTables && onlyTables.length ? new Set(onlyTables.map(lc)) : null
    const inTables = (f) => TABLE_BOUND.has(f.code) && (f.code === 1 ? tableSet.has(lc(f.logical)) : [f.table, ...(f.tables || [])].some((t) => t && tableSet.has(lc(t))))
    const t0 = performance.now(); requests = 0
    if (!allSolutions) allSolutions = await listManagedSolutions()
    const warnings = [], failed = [], notes = [], noAccess = []   // noAccess: types the user's security role cannot read
    progress('Reading tables…', 2)
    const [tablesRows, colRows, defs] = await Promise.all([
      getAll(`EntityDefinitions?$select=LogicalName,SchemaName,DisplayName,MetadataId,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`),
      getAll(`EntityDefinitions?$select=LogicalName&$expand=Attributes($select=LogicalName;$filter=${WANTED_COLUMNS.map((c) => `LogicalName eq '${c}'`).join(' or ')})`),
      getAll(`solutioncomponentdefinitions?$select=solutioncomponenttype,name,primaryentityname`),
    ])
    const tables = new Map(tablesRows.map((t) => [t.LogicalName, t]))
    const tableLabel = (logical) => { const t = tables.get(logical); return t ? `${label(t.DisplayName) || t.SchemaName} (${logical})` : logical || '' }
    const cols = new Map(colRows.map((t) => [t.LogicalName, new Set(t.Attributes.map((a) => a.LogicalName))]))
    // "Connection Reference" -> "Connection reference", as the maker portal writes it; acronyms stay.
    const sentence = (s) => s.split(' ').map((w, i) => i && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w).join(' ')
    const types = new Map(Object.entries(CLASSIC).map(([k, v]) => [Number(k), { table: v[0], kind: v[1], label: v[2] }]))
    const kindOf = new Map([...types.entries()].map(([k, v]) => [k, v.kind]))
    for (const d of defs) {
      if (!kindOf.has(d.solutioncomponenttype)) kindOf.set(d.solutioncomponenttype, d.name)
      if (!types.has(d.solutioncomponenttype) && d.primaryentityname) {
        const t = tables.get(d.primaryentityname)
        types.set(d.solutioncomponenttype, { table: d.primaryentityname, kind: d.name, label: sentence((t && label(t.DisplayName)) || d.name) })
      }
    }
    const typeLabel = (code, sub) => {
      if (code === 29 && sub != null) return WORKFLOW_TYPE[sub] || 'Process'
      if (code === 60 && sub != null) return FORM_TYPE[sub] || 'Form'
      if (code === 26 && sub != null) return VIEW_TYPE[sub] || 'View'
      return (types.get(code) || {}).label || kindOf.get(code) || `Type ${code}`
    }

    // 1. One sweep per component type.
    const found = new Map(), metaRows = [], noColumns = []
    let done = 0
    const typeList = [...types.entries()].filter(([code, ty]) => ty.table && typeWanted(code, ty.kind, groups) && (!tableSet || TABLE_BOUND.has(code)))
    await pool(typeList, CONFIG.concurrency, async ([code, ty]) => {
      try {
        if (METADATA[code]) {
          const [set, pk, nm] = METADATA[code]
          for (const r of await getAll(`${set}?$select=${pk},${nm}&$filter=solutionid eq ${ACTIVE}`)) metaRows.push({ code, id: lc(r[pk]), name: r[nm] })
        } else {
          const t = tables.get(ty.table), c = cols.get(ty.table)
          if (!t || !t.EntitySetName || !c || !c.has('solutionid') || !c.has('ismanaged')) { noColumns.push(code); return }
          const has = (col) => col && (c.has(col) || col === t.PrimaryNameAttribute)
          const [dCol0, sCol0] = NAMES[code] || [t.PrimaryNameAttribute, SCHEMA_GUESS.find((x) => c.has(x)) || null]
          const dCol = has(dCol0) ? dCol0 : t.PrimaryNameAttribute, sCol = has(sCol0) ? sCol0 : null
          const tCol = TABLE_COLUMN[code], subCol = has(SUBTYPE_COLUMN[code]) ? SUBTYPE_COLUMN[code] : null
          const sel = [...new Set([t.PrimaryIdAttribute, dCol, sCol, tCol, subCol].filter(Boolean))].join(',')
          const extra = TYPE_FILTER[code] ? ` and ${TYPE_FILTER[code]}` : ''
          for (const r of await getAll(`${t.EntitySetName}?$select=${sel}&$filter=solutionid eq ${ACTIVE} and ismanaged eq true${extra}`)) {
            const id = lc(r[t.PrimaryIdAttribute])
            const table = tCol && r[tCol] && r[tCol] !== 'none' ? r[tCol] : ''
            const sub = subCol ? r[subCol] : null
            found.set(`${code}|${id}`, { key: `${code}|${id}`, code, kind: ty.kind, id, display: (dCol && r[dCol]) || '', schema: (sCol && r[sCol]) || '', logical: (sCol && r[sCol]) || (dCol && r[dCol]) || '', table,
              type: code === 60 && !table && sub === 0 ? 'Dashboard' : typeLabel(code, sub) })
          }
        }
      } catch (e) {
        if (e instanceof SessionError) throw e
        // A type the user's security role cannot read (for example image configurations): not an error, but said.
        const priv = e.status === 403 && /CheckPrivilege/i.test(e.message) && /prv\w+/.exec(e.message)
        if (priv) noAccess.push({ type: ty.label, kind: ty.kind, privilege: priv[0] }); else failed.push(`${ty.kind}: ${e.message}`)
      }
      progress(`Checking component types (${++done} of ${typeList.length})…`, 5 + 45 * done / typeList.length)
    })

    // Tables, columns, relationships and keys: keep the managed ones. Metadata is read 100 tables at a time.
    if (metaRows.length) {
      progress('Checking tables, columns and relationships…', 52)
      const managed = new Map(), tableOf = new Map(), names = new Map()
      try {
        for (const t of tablesRows) names.set(lc(t.MetadataId), { display: label(t.DisplayName), schema: t.SchemaName })
        const logicals = [...tables.keys()].filter((n) => !tableSet || tableSet.has(lc(n)))   // chosen tables: only theirs
        const chunks = []
        for (let i = 0; i < logicals.length; i += 100) chunks.push(logicals.slice(i, i + 100))
        await pool(chunks, 2, async (chunk) => {
          const filter = chunk.map((n) => `LogicalName eq '${n}'`).join(' or ')
          for (const t of await getAll(`EntityDefinitions?$select=LogicalName,MetadataId,IsManaged&$filter=${filter}&$expand=Attributes($select=MetadataId,IsManaged,SchemaName,DisplayName),Keys($select=MetadataId,IsManaged,SchemaName,DisplayName)`)) {
            managed.set(lc(t.MetadataId), t.IsManaged); tableOf.set(lc(t.MetadataId), t.LogicalName)
            for (const a of [...t.Attributes, ...t.Keys]) { managed.set(lc(a.MetadataId), a.IsManaged); tableOf.set(lc(a.MetadataId), t.LogicalName); names.set(lc(a.MetadataId), { display: label(a.DisplayName), schema: a.SchemaName }) }
          }
        })
        const [rels, o2m, m2m] = await Promise.all([
          getAll(`RelationshipDefinitions?$select=MetadataId,SchemaName,IsManaged`),
          getAll(`RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=MetadataId,ReferencedEntity,ReferencingEntity`),
          getAll(`RelationshipDefinitions/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$select=MetadataId,Entity1LogicalName,Entity2LogicalName`),
        ])
        const relByName = new Map(rels.map((r) => [lc(r.SchemaName), r]))
        const relTables = new Map([...o2m.map((r) => [lc(r.MetadataId), [r.ReferencingEntity, r.ReferencedEntity]]), ...m2m.map((r) => [lc(r.MetadataId), [r.Entity1LogicalName, r.Entity2LogicalName]])])
        const internal = [], unknown = []
        for (const m of metaRows) {
          let id = m.id, isManaged = managed.get(id), extra = {}
          // A relationship's own settings (cascading) are layered on its "Relationship" component, whose id is the
          // relationships-table id; its definition ("EntityRelationship") uses the metadata id. Both are checked.
          if (m.code === 10) { const r = relByName.get(lc(m.name)); if (r) { id = lc(r.MetadataId); isManaged = r.IsManaged; extra = { alt: [{ id: m.id, kind: 'Relationship' }], tables: relTables.get(id) || [], schemaName: r.SchemaName } } }
          if (isManaged === undefined) {   // no definition found
            if (tableSet && m.code !== 10) continue   // a table that was not chosen (only the chosen tables were read)
            // Known internal rows: hidden "...dsc" columns, and the two internal halves ("One"/"Two") of a many-to-many relationship.
            const half = m.code === 10 && /(One|Two)$/.test(m.name) && relByName.has(lc(m.name.replace(/(One|Two)$/, '')))
            ;(m.code === 2 && /dsc$/i.test(m.name) || half ? internal : unknown).push(`${types.get(m.code).label} ${m.name}`)
            continue
          }
          if (isManaged !== true) continue   // unmanaged-only components are not layers on managed solutions
          const nm = names.get(id) || {}
          const table = m.code === 1 ? '' : m.code === 10 ? (extra.tables || [])[0] || '' : tableOf.get(id) || ''
          found.set(`${m.code}|${id}`, { key: `${m.code}|${id}`, code: m.code, kind: types.get(m.code).kind, type: types.get(m.code).label, id,
            display: nm.display || '', schema: extra.schemaName || nm.schema || m.name, logical: m.name, table, ...extra })
        }
        if (internal.length) notes.push(`${internal.length} internal rows (hidden ...dsc columns, internal halves of many-to-many relationships) have no definition and are not listed.`)
        if (unknown.length) failed.push(`${unknown.length} table, column, relationship or key rows with an unmanaged top layer have no matching definition: ${unknown.slice(0, 20).join(', ')}${unknown.length > 20 ? ', ...' : ''}`)
      } catch (e) { if (e instanceof SessionError) throw e; failed.push(`Tables, columns and relationships: ${e.message}`) }
    }

    // 2. The maker portal's "Customized" flag, for the types the sweep cannot read (global option sets and others).
    progress('Checking other customized components…', 58)
    try {
      const summaryRows = await getAll(`msdyn_solutioncomponentsummaries?$filter=(msdyn_solutionid eq ${DEFAULT}) and (msdyn_hasactivecustomization eq 'true') and (msdyn_ismanaged eq 'true')&$select=msdyn_componenttype,msdyn_componenttypename,msdyn_objectid,msdyn_name,msdyn_displayname,msdyn_primaryentityname`)
      for (const s of summaryRows) {
        const code = Math.round(Number(s.msdyn_componenttype)), id = lc(s.msdyn_objectid), key = `${code}|${id}`
        if (found.has(key)) continue
        const table = s.msdyn_primaryentityname && s.msdyn_primaryentityname !== 'none' ? s.msdyn_primaryentityname : ''
        found.set(key, { key, code, kind: kindOf.get(code) || s.msdyn_componenttypename, kindGuessed: !kindOf.has(code), type: typeLabel(code, null), id,
          display: s.msdyn_displayname || '', schema: s.msdyn_name || '', logical: s.msdyn_name, table, fromSummary: true })
      }
      const summaryKinds = new Set([1, 26, 29, 60, 61, 80, 62, 20])   // types the summary flags whenever they are customized
      let broken = !summaryRows.length && [...found.values()].some((f) => summaryKinds.has(f.code))
      if (!summaryRows.length && !broken) {   // nothing customized at all, or a summary that answers nothing: it always lists the Default solution's tables
        const probe = await read(`msdyn_solutioncomponentsummaries?$filter=(msdyn_solutionid eq ${DEFAULT}) and (msdyn_componenttype eq 1)&$select=msdyn_objectid&$top=1`)
        broken = !(probe && Array.isArray(probe.value) && probe.value.length)
      }
      if (broken) failed.push('Solution summary: it returned nothing although it should list the customized components, so global option sets and other types without a table were not checked')
      // Forms and processes found only by the summary: read their kind, so they get the right type (and object type group).
      for (const f of found.values()) {
        if (!f.fromSummary || (f.code !== 60 && f.code !== 29)) continue
        if (tableSet && f.table && !tableSet.has(lc(f.table))) continue   // on a table that was not chosen
        try {
          if (!GUID.test(f.id)) continue
        const r = await read(f.code === 60 ? `systemforms(${f.id})?$select=type,objecttypecode` : `workflows(${f.id})?$select=category,primaryentity`)
          const sub = f.code === 60 ? r.type : r.category, table = (f.code === 60 ? r.objecttypecode : r.primaryentity) || ''
          if (!f.table && table && table !== 'none') f.table = table
          f.type = f.code === 60 && !f.table && sub === 0 ? 'Dashboard' : typeLabel(f.code, sub)
        } catch (e) { if (e instanceof SessionError) throw e }
      }
    } catch (e) { if (e instanceof SessionError) throw e; failed.push(`Solution summary (global option sets and types without a table): ${e.message}`) }

    // Only the chosen object types.
    if (groups) for (const [k, f] of found) if (!groups.has(groupOf(f))) found.delete(k)
    // Only the components of the chosen tables.
    if (tableSet) for (const [k, f] of found) if (!inTables(f)) found.delete(k)

    // 3. Keep the components that belong to the chosen managed solutions. The solution component rows of the found
    //    components, and of the tables their parts are on, are read by id (50 at a time), so the cost follows the
    //    number of findings, not the size of the solutions.
    progress('Finding which solutions the components are in…', 62)
    const allNames = new Map(allSolutions.map((s) => [s.unique, s.name]))
    const managedById = new Map(allSolutions.map((s) => [s.id, s]))
    const chosenIds = new Set(solutions.map((s) => s.id))
    const tableId = new Map(tablesRows.map((t) => [t.LogicalName, lc(t.MetadataId)]))
    const tablesOf = (f) => TABLE_PARTS.has(f.code) ? [f.table, ...(f.tables || [])].filter((t) => tableId.has(t)) : []
    const rowsOf = new Map()   // objectid -> rows in managed solutions
    const idList = [...new Set([...found.values()].flatMap((f) => [f.id, ...(f.alt ? [f.alt[0].id] : []), ...tablesOf(f).map((t) => tableId.get(t))]))].filter((x) => GUID.test(String(x)))
    try {
      for (let i = 0; i < idList.length; i += 50) {
        const list = idList.slice(i, i + 50).map((x) => `'${x}'`).join(',')
        for (const c of await getAll(`solutioncomponents?$select=objectid,componenttype,rootcomponentbehavior,_solutionid_value&$filter=Microsoft.Dynamics.CRM.In(PropertyName='objectid',PropertyValues=[${list}])`)) {
          const sol = lc(c._solutionid_value)
          if (!managedById.has(sol)) continue   // rows in unmanaged solutions (Default, Active and others) do not count
          const k = lc(c.objectid), a = rowsOf.get(k) || []
          a.push({ sol, type: c.componenttype, behavior: c.rootcomponentbehavior }); rowsOf.set(k, a)
        }
        progress(`Finding which solutions the components are in (${Math.min(i + 50, idList.length)} of ${idList.length})…`, 62 + 2 * Math.min(1, (i + 50) / idList.length))
      }
    } catch (e) { if (e instanceof SessionError) throw e; failed.push(`Solutions of the components: ${e.message}`) }
    const solsOf = (f) => {
      const s = new Set()
      for (const id of [f.id, ...(f.alt ? [f.alt[0].id] : [])]) for (const r of rowsOf.get(id) || []) s.add(r.sol)
      f.listedIn = [...s]   // solutions whose component list has it (the maker portal opens it in those)
      // A table held "with all objects" brings its columns, forms, views, charts, keys and relationships.
      for (const t of tablesOf(f)) for (const r of rowsOf.get(tableId.get(t)) || []) if (r.type === 1 && r.behavior === 0) s.add(r.sol)
      return [...s]
    }
    const sortIds = (ids) => [...new Set(ids)].sort((x, y) => managedById.get(x).name.localeCompare(managedById.get(y).name))
    const names = (ids) => [...new Set(ids.map((x) => managedById.get(x).name))].sort((x, y) => x.localeCompare(y)).join(', ')
    const inScope = [], outOfScope = [], noRow = []
    const oos = (f, extra) => outOfScope.push({ type: f.type, display: f.display, schema: f.schema, table: f.table, id: f.id, code: f.code, ...extra })
    for (const f of found.values()) {
      f.tableLabel = f.table ? tableLabel(f.table) : ''
      f.tableId = f.code === 1 ? f.id : tableId.get(f.table) || ''   // for the maker portal link
      const all = solsOf(f), chosen = all.filter((x) => chosenIds.has(x))
      if (chosen.length) { f.solutions = names(chosen); f.solutionIds = sortIds(chosen); f.linkSolution = sortIds(chosen.filter((x) => f.listedIn.includes(x)))[0] || f.solutionIds[0]; inScope.push(f) }
      else if (all.length) oos(f, { inSolutions: names(all) })
      else noRow.push(f)
    }
    // Some parts of standard tables (for example hidden name columns of System tables) are in a managed solution
    // without a row of their own in any component list. For those, their managed layers say which solutions they are in.
    // One that cannot be placed might be in a chosen solution, so the scan is then incomplete.
    const toCheck = noRow.slice(0, CONFIG.layerCheckLimit), notPlaced = []
    const someOf = (list) => list.slice(0, 20).map((f) => `${f.type} ${f.schema || f.display || f.id}`).join(', ') + (list.length > 20 ? ', ...' : '')
    if (noRow.length > toCheck.length) failed.push(`Solutions of ${noRow.length - toCheck.length} components with an unmanaged layer that are in no solution's component list: there are more than ${CONFIG.layerCheckLimit.toLocaleString()}, so they were not checked: ${someOf(noRow.slice(CONFIG.layerCheckLimit))}`)
    let checked = 0
    await pool(toCheck, CONFIG.detailConcurrency, async (f) => {
      try {
        const managedUnique = await readDetails(f, allNames)
        const chosen = allSolutions.filter((s) => chosenIds.has(s.id) && managedUnique.includes(s.unique)).map((s) => s.id)
        if (chosen.length) { f.solutions = names(chosen); f.solutionIds = sortIds(chosen); f.placedByLayers = true; inScope.push(f) }
        else if (f.noLayer) { /* no unmanaged layer after all */ }
        else if (/could not be read/.test(f.changed || '')) { notPlaced.push(f); oos(f, { error: f.changed }) }
        else oos(f, { layers: f.layers })
      } catch (e) { if (e instanceof SessionError) throw e; notPlaced.push(f); oos(f, { error: e.message }) }
      progress(`Checking the remaining components (${++checked} of ${toCheck.length})…`, 64 + 5 * checked / Math.max(1, toCheck.length))
    })
    if (notPlaced.length) failed.push(`Solutions of ${notPlaced.length} components with an unmanaged layer: they are in no solution's component list and their layers could not be read, so it is not known whether they are in the chosen solutions: ${someOf(notPlaced)}`)
    for (const f of noRow.slice(CONFIG.layerCheckLimit)) oos(f, { notChecked: true })
    inScope.sort((a, b) => a.type.localeCompare(b.type) || (a.display || a.schema).localeCompare(b.display || b.schema))

    const result = { org: ORG, url: ORIGIN, scannedOn: new Date().toISOString(), seconds: 0, requests: 0, solutions: solutions.map((s) => s.unique), types: groups ? [...groups] : null,
      tables: tableSet ? [...tableSet] : null, noAccess,
      environmentFindings: found.size, outOfScope,
      // every component with an unmanaged layer in the environment, in any solution: the removal check compares against it
      environment: [...found.values()].map((f) => ({ key: f.key, code: f.code, kind: f.kind, type: f.type, display: f.display, schema: f.schema, fromSummary: !!f.fromSummary })), typesChecked: typeList.length, typesWithoutColumns: noColumns, typesFailed: failed, warnings, notes, cleared: [], findings: inScope,
      solutionNames: new Map(allSolutions.map((s) => [s.unique, s.name])) }
    // 4. Details: the managed layers underneath and what the unmanaged layer changes. Components flagged only by the
    //    solution summary are read first, all of them and whatever the details setting: the summary also flags a table
    //    when only one of its parts is customized, so only their own layers say whether they have an unmanaged layer.
    //    The other findings' details are read up to autoDetails (the rest on request).
    //    More than layerCheckLimit of them: the rest stay "not read yet" (the banner says they aren't confirmed yet).
    const unread = result.findings.filter((f) => !f.detailsLoaded)
    const confirm = unread.filter((f) => f.fromSummary).slice(0, CONFIG.layerCheckLimit)
    const toRead = details ? [...confirm, ...unread.filter((f) => !f.fromSummary).slice(0, CONFIG.autoDetails)] : confirm
    if (toRead.length) await loadDetails(result, toRead, progress)
    // One whose layers could not be read is not confirmed, so the list might hold it wrongly: the scan is incomplete.
    // (A type whose layer name is not known is the exception: it is shown as "Layers could not be read".)
    const kept = new Set(result.findings), unconfirmed = confirm.filter((f) => kept.has(f) && !f.kindGuessed && !(f.activeKinds || []).length)
    if (unconfirmed.length) failed.push(`${unconfirmed.length} components flagged only by the solution summary could not be confirmed, because their layers could not be read: ${someOf(unconfirmed)}`)
    result.seconds = (performance.now() - t0) / 1000
    result.requests = requests
    progress(statusLine(result), 100)
    return result
  }

  // Reads the layers of one component: the managed layers underneath (top first) and what the unmanaged layer changes.
  // Returns the unique names of its managed layers' solutions.
  async function readDetails(f, names) {
    let any = false, managedLayers = null, keys = [], readAll = true, sawLayers = false
    const activeKinds = [], layerList = []
    for (const p of places(f)) {
      let layers
      try { layers = await getLayers(p.id, p.kind) } catch (e) { if (e instanceof SessionError) throw e; readAll = false; continue }
      if (layers.length) sawLayers = true
      for (const l of layers) layerList.push({ place: p.kind, order: l.msdyn_order, solution: l.msdyn_solutionname, publisher: l.msdyn_publishername || '', overwrite: l.msdyn_overwritetime || '', name: l.msdyn_name || '', layerId: l.msdyn_componentlayerid || '', changes: changedKeys(l).length })
      const active = layers.find((l) => l.msdyn_solutionname === 'Active')
      if (!managedLayers && layers.some((l) => l.msdyn_solutionname !== 'Active')) managedLayers = layers.filter((l) => l.msdyn_solutionname !== 'Active').map((l) => l.msdyn_solutionname)
      if (active && layers.some((l) => l.msdyn_solutionname !== 'Active')) { any = true; activeKinds.push(p.kind); keys = keys.concat(changedKeys(active)); if (!f.display && !f.schema) f.display = active.msdyn_name || '' }
    }
    f.activeKinds = activeKinds
    f.layerList = layerList
    f.layers = managedLayers ? managedLayers.map((u) => names.get(u) || u).join(' > ') : ''
    f.detailsLoaded = true
    if (any) {
      const extra = keys.filter((k) => !STATE_ONLY.has(k) && !/idunique$/i.test(k))
      f.stateOnly = f.kind === 'Workflow' && extra.length === 0 && keys.some((k) => ['statecode', 'statuscode', 'ownerid', 'owninguser', 'owningteam'].includes(k))
      f.changed = f.stateOnly ? 'Only status or owner' : extra.length ? [...new Set(extra)].slice(0, 10).join(', ') : 'Only system values'
      f.changedKeys = !f.stateOnly && extra.length ? [...new Set(extra)] : undefined   // all of them (What changed shows the first 10)
    } else if (readAll && sawLayers && !f.kindGuessed) f.noLayer = true   // its managed layers were read and none is unmanaged: not a finding
    else f.changed = sawLayers || !readAll ? 'Layers could not be read' : `Layers could not be read (no layers under the name ${f.kind})`
    return any ? managedLayers || [] : []
  }
  async function loadDetails(result, list, progress = () => {}) {
    let n = 0
    const names = result.solutionNames || new Map()
    await pool(list, CONFIG.detailConcurrency, async (f) => {
      try { await readDetails(f, names) } catch (e) { if (e instanceof SessionError) throw e; f.changed = 'Layers could not be read' }
      progress(`Reading what changed (${++n} of ${list.length})…`, 70 + 29 * n / list.length)
    })
    const cleared = new Set(result.findings.filter((f) => f.noLayer).map((f) => f.key))
    result.cleared = (result.cleared || []).concat(result.findings.filter((f) => cleared.has(f.key)).map((f) => `${f.type} ${f.schema || f.display}`))
    result.findings = result.findings.filter((f) => !cleared.has(f.key))
  }
  function statusLine(r) {
    const left = r.findings.filter((f) => !f.detailsLoaded).length
    let s = `Found ${r.findings.length} components with an unmanaged layer in the ${r.solutions.length} chosen managed solution(s)${r.types ? ` (${r.types.join(', ')} only)` : ''}, in ${r.seconds.toFixed(1)} s (${r.requests} requests).`
    if (left) s += ` What changed isn't read yet for ${left}.`
    if (r.noAccess && r.noAccess.length) s += ` Not checked (no read access): ${r.noAccess.map((x) => x.type).join(', ')}.`
    if (r.typesFailed.length) s = `INCOMPLETE: ${r.typesFailed.length} part(s) could not be read (see Export JSON). ` + s
    return s
  }

  // ------------------------------------------------------------------ remove
  // One step per component, like "Remove active customizations" in the maker portal, with checks around it:
  //   - right before: its layers are read; only places with an unmanaged layer on top of at least one managed layer are
  //     touched (an unmanaged-only place is never removed: that would delete the component);
  //   - the call: RemoveActiveCustomizations (as the maker portal and Solution Layers Explorer use);
  //   - right after: the unmanaged layer must be gone and the managed layers exactly as before.
  // What the unmanaged layer held is kept in the log, so a change can be redone by hand if it was needed.
  async function removePlace(place) {
    placeOk(place.id, place.name)
    for (let tries = 0; ; tries++) {
      try {
        await write('GET', `RemoveActiveCustomizations(SolutionComponentName='${place.name}',ComponentId=${place.id})`)
        return null
      } catch (e) {
        if (e instanceof SessionError) throw e
        if (/Resource not found for the segment 'RemoveActiveCustomizations'/i.test(e.message)) {   // older environments: the documented action
          try { await write('POST', 'RemoveActiveCustomization', { LogicalName: lc(place.name), Id: place.id }); return null } catch (e2) { if (e2 instanceof SessionError) throw e2; return e2.message }
        }
        if (/0x8004F077|CustomizationLock|another .* running/i.test(e.message) && tries < 5) { await sleep(10000); continue }   // an import or publish holds the lock
        if (/0x8004f059|not supported for components of type/i.test(e.message)) return 'Dataverse does not allow deleting the unmanaged layer of this component type. Undo the change by hand, or import its managed solution again with "Overwrite unmanaged customizations".'
        return e.message
      }
    }
  }
  // items: findings. onRow(f, state, detail) reports progress per component. Returns [{ f, outcome, detail, layers, ms }]
  // in the order of items. One component at a time (CONFIG.deleteConcurrency), each with its own check before and after;
  // the places of one component (a relationship has two) are done one after the other.
  // shouldStop(): true when the user stopped the run; the components not started yet are then not attempted.
  async function removeLayers(items, onRow = () => {}, { concurrency = CONFIG.deleteConcurrency, shouldStop = () => false } = {}) {
    if (IS_DEV) throw new Error('Deleting is turned off in development environments.')
    const results = new Array(items.length)
    let stopped = null
    results.userStopped = 0
    // onRow(f, state, detail, result): the result (with the removed changes) as soon as a component is done, so the
    // log keeps it even if the run ends early. The screen cannot stop or lose a run.
    const report = (f, state, detail, r) => { try { onRow(f, state, detail, r) } catch { } }
    const notTried = (f, why) => { const r = { f, outcome: 'Not attempted', detail: why, layers: [], ms: {} }; report(f, r.outcome, why, r); return r }
    async function one(f) {
      if (stopped) return notTried(f, stopped)
      let stop = false
      try { stop = !!shouldStop() } catch { }
      if (stop) { results.userStopped++; return notTried(f, 'you stopped the run') }
      report(f, 'Deleting')
      const outcomes = [], details = [], kept = [], many = places(f).length > 1, ms = { read: 0, remove: 0, check: 0 }
      let sawLayers = false, touched = false, called = false
      const say = (p, text) => details.push(many ? `${p.kind === 'Relationship' ? 'cascade settings' : 'definition'}: ${text}` : text)
      const timed = async (k, fn) => { const t = performance.now(); try { return await fn() } finally { ms[k] += Math.round(performance.now() - t) } }
      try {
        for (const p of places(f)) {
          let before
          try { before = await timed('read', () => getLayers(p.id, p.kind)) } catch (e) { if (e instanceof SessionError) throw e; outcomes.push('Failed'); say(p, `its layers could not be read (${e.message}); nothing was deleted`); continue }
          if (before.length) sawLayers = true
          const top = before.find((l) => l.msdyn_solutionname === 'Active'), managedBefore = managedOf(before), printBefore = managedPrint(before)
          if (!top || before[0] !== top || !managedBefore.length) continue   // nothing to delete here, or unmanaged-only (deleting that would delete the component)
          touched = true
          const name = top.msdyn_solutioncomponentname || p.kind
          const entry = { place: p.kind, id: p.id, layerName: name, result: '', changes: top.msdyn_changes || '' }
          kept.push(entry)
          called = true
          const error = await timed('remove', () => removePlace({ id: p.id, name }))
          let after = null
          try { after = await timed('check', () => getLayers(p.id, name)) } catch (e) { if (e instanceof SessionError) throw e }
          if (!after) { outcomes.push(error ? 'Unknown' : 'Deleted, not verified'); say(p, error ? `the call returned an error and the layers could not be read again: ${error}` : 'the layers could not be read again to check') }
          else if (after.some((l) => l.msdyn_solutionname === 'Active')) { outcomes.push('Failed'); say(p, error || 'the unmanaged layer is still there') }
          else if (JSON.stringify(managedOf(after)) !== JSON.stringify(managedBefore)) { outcomes.push('Failed'); say(p, `the managed layers changed: before ${managedBefore.join(' > ')}, now ${managedOf(after).join(' > ')}`) }
          else if (JSON.stringify(managedPrint(after)) !== JSON.stringify(printBefore)) { outcomes.push('Unknown'); say(p, 'the unmanaged layer is gone, but the values of a managed layer changed at the same time (another import or change?); check its layers') }
          else outcomes.push('Deleted')
          entry.result = outcomes[outcomes.length - 1]
        }
        if (!touched && !outcomes.length) { outcomes.push('Skipped'); details.push(sawLayers ? 'it has no unmanaged layer on top of a managed layer any more' : `its layers could not be read (no layers under the name ${f.kind})`) }
      } catch (e) {
        if (!(e instanceof SessionError)) { outcomes.push('Unknown'); details.push(`stopped on an error: ${e.message}`) }
        else if (!called) { stopped = 'the sign-in expired'; outcomes.push('Not attempted'); details.push('the sign-in expired before this component was tried') }
        else { stopped = 'the sign-in expired'; outcomes.push('Unknown'); details.push('the sign-in expired during this component; check its layers after signing in again') }
      }
      const every = (v) => outcomes.length > 0 && outcomes.every((o) => o === v)
      const outcome = every('Deleted') ? 'Deleted' : every('Skipped') ? 'Skipped' : every('Not attempted') ? 'Not attempted' : outcomes.includes('Unknown') && !outcomes.includes('Failed') ? 'Unknown' : outcomes.some((o) => o.startsWith('Deleted')) ? (outcomes.every((o) => o.startsWith('Deleted')) ? 'Deleted, not verified' : 'Partly deleted') : outcomes.includes('Unknown') ? 'Unknown' : 'Failed'
      const r = { f, outcome, detail: details.join('; '), layers: kept, ms }
      report(f, outcome, r.detail, r)
      return r
    }
    armed = true
    try {
      let next = 0
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        while (next < items.length) { const k = next++; results[k] = await one(items[k]) }
      }))
      results.stopped = stopped
    } finally { armed = false }
    return results
  }

  // ------------------------------------------------------------------ files
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  function download(name, text, type) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type }))
    a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 60000)
  }
  const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"` }   // no spreadsheet formulas
  const toCsv = (rows) => '﻿' + ['Type,Display name,Schema name,Table,Managed solution,Managed layers (top first),What changed,Component id,Solution layers page',
    ...rows.map((f) => [f.type, f.display, f.schema, f.tableLabel, f.solutions, f.layers, f.changedKeys ? f.changedKeys.join(', ') : f.changed, f.id, layersUrl(f)].map(csvCell).join(','))].join('\r\n')
  // Every layer of each component, as Solution Layers Explorer's Excel export (plus the component's own columns).
  const layersCsv = (rows, solName) => '\ufeff' + ['Type,Display name,Schema name,Table,Managed solution,Component id,Layer component name,Order,Layer solution (unique name),Layer solution,Publisher,Overwrite time,Changed properties,Component layer id',
    ...rows.flatMap((f) => (f.layerList && f.layerList.length ? f.layerList : [null]).map((l) => [f.type, f.display, f.schema, f.tableLabel, f.solutions, f.id,
      ...(l ? [l.place, l.order, l.solution, l.solution === 'Active' ? 'Active (unmanaged layer)' : solName(l.solution), l.publisher, /^1900/.test(l.overwrite) ? '' : l.overwrite, l.changes, l.layerId] : ['(layers not read)'])].map(csvCell).join(',')))].join('\r\n')
  const exportJson = (r) => JSON.stringify({ ...r, solutionNames: undefined, environment: undefined }, null, 1)

  // ------------------------------------------------------------------ links to the solution layers pages
  // Each row opens the page that shows the component's solution layers. Most types: the maker portal, in the managed
  // solution the component was found in (the page loads a component that the solution in its address lists, or holds
  // through its table "with all objects"). A component placed by its layers only (no row in any component list) opens
  // in the Default solution, which has every component. Types the maker portal cannot show (display strings, plug-in
  // types and step images, record filters, channel access profiles), and a relationship whose unmanaged layer is on its
  // cascade settings only: the classic Solution Layers page of the environment. All checked in the demo environment.
  const PART_SEGMENT = { 2: 'fields', 10: 'relationships', 14: 'keys', 26: 'views', 59: 'charts', 60: 'forms' }
  const CLASSIC_PAGE = new Set([22, 72, 73, 90, 93, 172])
  const classicLayers = (kind, id) => `${ORIGIN}/WebResources/msdyn_/solutionlayers/index.html#/componentlayers/${encodeURIComponent(kind)}/${id}`
  function layersUrl(f) {
    if (f.code === 10 && f.alt && f.activeKinds && f.activeKinds.length && f.activeKinds.every((k) => k === 'Relationship')) return classicLayers('Relationship', f.alt[0].id)
    if ((CLASSIC_PAGE.has(f.code) || !conn.envId) && !f.kindGuessed) return classicLayers(f.kind, f.id)
    if (!conn.envId) return ''
    const base = `${MAKER}/environments/${conn.envId}/solutions/${f.placedByLayers || !f.linkSolution ? DEFAULT : f.linkSolution}`
    if (f.code === 1) return `${base}/entities/${f.id}/layers`
    const seg = PART_SEGMENT[f.code] || (f.code === 29 && f.type === 'Business rule' ? 'business%20rules' : '')
    if (seg && f.tableId) return `${base}/objects/entities/${f.tableId}/${seg}/${f.id}/layers`
    return `${base}/objects/all/${f.id}/layers`
  }

  // ------------------------------------------------------------------ UI
  // Fluent 2 design (the maker portal's own design language), drawn in a shadow root so the page's styles do not
  // reach it. Two screens: the choice (solutions, object types, saved selections) and the results. Deleting is one
  // confirmation, as in the maker portal. Nothing is inserted above content after it is drawn, so nothing jumps.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const P = {   // 20 x 20 icons
    layers: 'M10 2.5 2.5 6.5 10 10.5l7.5-4L10 2.5ZM2.5 10l7.5 4 7.5-4M2.5 13.5l7.5 4 7.5-4',
    close: 'M5 5l10 10M15 5 5 15', back: 'M12.5 4.5 7 10l5.5 5.5', search: 'M8.5 3.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10ZM12.2 12.2 16.5 16.5',
    refresh: 'M15.5 8A6 6 0 1 0 16 11.5M15.5 3.5V8H11', download: 'M10 3v9.5M6 9l4 4 4-4M4 16.5h12', chevron: 'M6 8l4 4 4-4',
    open: 'M11 4h5v5M16 4l-7 7M14.5 11.5v3a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 14.5V7a1.5 1.5 0 0 1 1.5-1.5h3',
    check: 'M4.5 10.5 8 14l7.5-8', warn: 'M10 3.5 17 16H3L10 3.5ZM10 8.5v3.5M10 14v.2', trash: 'M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6M8.5 9v4M11.5 9v4',
    save: 'M5.5 3.5h9v13L10 13.5l-4.5 3V3.5Z', info: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM10 9v4.5M10 6.5v.2',
    error: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM7.5 7.5l5 5M12.5 7.5l-5 5', okc: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM7 10.2l2 2 4-4.4',
    filter: 'M3.5 4.5h13l-5 6.2v4.3l-3 1.5v-5.8l-5-6.2Z', sortUp: 'M10 16V4.5M5.5 9 10 4.5 14.5 9', sortDown: 'M10 4v11.5M5.5 11 10 15.5 14.5 11',
    maximize: 'M4.5 4.5h11v11h-11Z', swap: 'M4 7h12l-3-3M16 13H4l3 3', restore: 'M4.5 7.5h8v8h-8ZM7.5 7.5v-3h8v8h-3', up: 'M5 12.5l5-5 5 5', down: 'M5 7.5l5 5 5-5',
    diff: 'M6 3.5h5.5L15 7v9a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5ZM8 13.5h4M10 7.5v4M8 9.5h4',
    copy: 'M7.5 6.5V4a.5.5 0 0 1 .5-.5h7.5a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5H13M4.5 6.5h8v10h-8Z', table: 'M3.5 4.5h13v11h-13ZM3.5 8.5h13M3.5 12h13M8 8.5v7',
  }
  const icon = (n, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${s >= 20 ? 1.25 : 1.5}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[n]}"/></svg>`
  const TYPE_SECTIONS = [['Data', ['Tables', 'Columns', 'Relationships', 'Keys', 'Choices']], ['Forms and views', ['Forms', 'Views', 'Charts', 'Dashboards']],
    ['Automation', ['Cloud flows', 'Business rules', 'Other processes', 'Plug-ins']], ['Apps and resources', ['Apps', 'Site maps', 'Web resources', 'Email templates', 'Reports', 'Display strings']],
    ['Security and settings', ['Security roles', 'Column security profiles', 'Environment variables', 'Connection references']], ['Everything else', ['Other']]]
  const STYLE = `
:host{all:initial}
*{box-sizing:border-box}
[hidden]{display:none!important}
.app{--brand:#0f6cbd;--brand-h:#115ea3;--brand-p:#0f548c;--brand-bg:#ebf3fc;--brand-s:#b4d6fa;--fg1:#242424;--fg2:#424242;--fg3:#616161;--fg4:#707070;
  --bg1:#fff;--bg2:#fafafa;--bg3:#f5f5f5;--bg4:#ebebeb;--s1:#d1d1d1;--s2:#e0e0e0;--s3:#f0f0f0;--red:#c50f1f;--red-h:#a80d1a;--red-bg:#fdf3f4;--red-s:#eeacb2;
  --green:#0e700e;--green-bg:#f1faf1;--amber:#8a3707;--amber-bg:#fff9f5;--amber-s:#fdcfb4;
  position:fixed;inset:0;pointer-events:none;
  font:14px/20px "Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif;color:var(--fg1);
  -webkit-font-smoothing:antialiased;animation:fade .15s ease-out}
@keyframes fade{from{opacity:0}} @keyframes rise{from{opacity:0;transform:translateY(10px)}} @keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{from{background-position:100% 0}to{background-position:-100% 0}} @keyframes toastOut{to{opacity:0;transform:translateY(8px)}}
@keyframes slideIn{from{opacity:0;transform:translateX(24px)}}
.win{position:absolute;pointer-events:auto;display:flex}
.win.max{left:0!important;top:0!important;width:100%!important;height:100%!important}
.panel{flex:1;min-width:0;background:var(--bg1);border-radius:8px;box-shadow:0 0 2px rgba(0,0,0,.12),0 32px 64px rgba(0,0,0,.24);display:flex;flex-direction:column;overflow:hidden;position:relative;z-index:0;container-type:inline-size;animation:rise .22s cubic-bezier(.1,.9,.2,1)}
.win.max .panel{border-radius:0}
.rz{position:absolute;z-index:1} .win.max .rz{display:none}
.rz.n,.rz.s{left:14px;right:14px;height:8px;cursor:ns-resize} .rz.n{top:-6px} .rz.s{bottom:-6px}
.rz.e,.rz.w{top:14px;bottom:14px;width:8px;cursor:ew-resize} .rz.e{right:-6px} .rz.w{left:-6px}
.rz.ne,.rz.nw,.rz.se,.rz.sw{width:18px;height:18px} .rz.ne{top:-6px;right:-6px;cursor:nesw-resize} .rz.sw{bottom:-6px;left:-6px;cursor:nesw-resize}
.rz.nw{top:-6px;left:-6px;cursor:nwse-resize} .rz.se{bottom:-6px;right:-6px;cursor:nwse-resize}
.app.moving,.app.sizing{pointer-events:auto} .app.moving .panel,.app.sizing .panel{user-select:none}
.top{display:flex;align-items:center;gap:12px;height:56px;padding:0 12px 0 24px;border-bottom:1px solid var(--s2);flex:none;cursor:move;user-select:none} .top .btn{cursor:pointer}
.top .tbtns{display:flex;gap:2px}
.logo{width:28px;height:28px;border-radius:6px;background:var(--brand);color:#fff;display:grid;place-items:center;flex:none}
.top h1{font-size:16px;line-height:22px;font-weight:600;margin:0}
.badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:10px;font-size:12px;line-height:16px;font-weight:600;background:var(--bg3);color:var(--fg2);border:1px solid var(--s2);white-space:nowrap}
.badge.prod{background:var(--red-bg);color:var(--red);border-color:var(--red-s)} .badge.dev{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-s)}
.spacer{flex:1}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
button{font:inherit;color:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:4px;border:1px solid var(--s1);background:var(--bg1);color:var(--fg1);font-weight:600;font-size:14px;white-space:nowrap;cursor:pointer;transition:background .1s,border-color .1s,color .1s;flex:none}
.btn:hover{background:var(--bg3);border-color:#c7c7c7} .btn:active{background:var(--bg4)}
.btn.primary{background:var(--brand);border-color:transparent;color:#fff} .btn.primary:hover{background:var(--brand-h)} .btn.primary:active{background:var(--brand-p)}
.btn.danger{background:var(--red);border-color:transparent;color:#fff} .btn.danger:hover{background:var(--red-h)}
.btn.danger-o{color:var(--red);border-color:var(--red)} .btn.danger-o:hover{background:var(--red-bg);border-color:var(--red-h);color:var(--red-h)}
.btn.subtle{border-color:transparent;background:transparent;color:var(--fg2)} .btn.subtle:hover{background:var(--bg3);color:var(--fg1)}
.btn:disabled,.btn:disabled:hover{cursor:default;background:#f0f0f0;border-color:#e0e0e0;color:#bdbdbd}
.btn.primary:disabled,.btn.danger:disabled{background:#f0f0f0;border-color:transparent;color:#bdbdbd}
.btn.subtle:disabled,.btn.subtle:disabled:hover{background:transparent;border-color:transparent;color:#bdbdbd}
.btn.icon{width:32px;padding:0} a.btn{text-decoration:none}
.btn:focus-visible{outline:0;border-color:#000;box-shadow:inset 0 0 0 1px #000}
.btn.primary:focus-visible,.btn.danger:focus-visible{border-color:#000;box-shadow:inset 0 0 0 1px #000,inset 0 0 0 2px #fff}
:focus-visible{outline:2px solid #000;outline-offset:1px}
.link{border:0;background:none;padding:0;color:#115ea3;font-weight:400;font-size:14px;line-height:20px;cursor:pointer} .link:hover{color:var(--brand-p);text-decoration:underline} .link:disabled{color:#bdbdbd;cursor:default;text-decoration:none}
.input{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:1px solid var(--s1);border-bottom-color:var(--fg3);border-radius:4px;background:var(--bg1);color:var(--fg3)}
.input:focus-within{border-bottom-color:var(--brand);box-shadow:inset 0 -1px 0 var(--brand)}
.input input{border:0;outline:0;background:transparent;font:inherit;color:var(--fg1);flex:1;min-width:0;height:100%;padding:0}
.input input::placeholder{color:var(--fg4)} .input input:disabled{color:#bdbdbd}
.input input::-webkit-search-cancel-button{-webkit-appearance:none;width:16px;height:16px;cursor:pointer;background:center/12px no-repeat url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><path d='M5 5l10 10M15 5 5 15' stroke='%23616161' stroke-width='1.6' stroke-linecap='round'/></svg>")}
input[type=checkbox]{width:16px;height:16px;margin:0;accent-color:var(--brand);cursor:pointer;flex:none;display:block}
input[type=checkbox]:disabled{cursor:default}
.view{flex:1;display:flex;flex-direction:column;min-height:0}
.bar{display:flex;align-items:center;gap:8px;height:64px;padding:0 24px;border-top:1px solid var(--s2);background:var(--bg1);flex:none}
.msg{color:var(--fg3);display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .msg>span{overflow:hidden;text-overflow:ellipsis}
.msg.bad{color:var(--red)} .msg b{color:var(--fg1);font-weight:600} .msg.bad b{color:var(--red)}
.quiet{color:var(--fg3)}
h2{font-size:20px;line-height:28px;font-weight:600;margin:0} h2:focus{outline:none} .sub{color:var(--fg3);margin:2px 0 0}
/* choice */
.pick-head{display:flex;align-items:flex-start;gap:16px;padding:20px 24px 16px;flex:none} .ph-text{flex:1;min-width:0}
.cols{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:16px;padding:0 24px 24px}
.rcol{display:flex;flex-direction:column;gap:16px;min-height:0}
.card.tables{flex:none} .card.types{flex:1;min-height:0}
.tb-body{padding:10px 16px 12px;display:flex;flex-direction:column;gap:8px;color:var(--fg2)}
.tb-tags{display:flex;flex-wrap:wrap;gap:6px;max-height:54px;overflow:hidden}
.ttag{display:inline-block;height:24px;line-height:24px;padding:0 8px;border-radius:4px;background:var(--bg3);color:var(--fg1);font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-body .hint{font-size:12px;line-height:16px;color:var(--fg3)}
.dialog.wide{width:min(720px,100%)}
.tl-tools{display:flex;align-items:center;gap:16px} .tl-tools .input{flex:1}
.tl-list{border:1px solid var(--s2);border-radius:4px;height:min(360px,40vh);overflow:auto}
.tl-row{display:flex;align-items:center;gap:12px;height:44px;padding:0 12px;border-bottom:1px solid var(--s3);cursor:pointer}
.tl-row:hover{background:var(--bg3)} .tl-row.on{background:var(--brand-bg)} .tl-row:focus-visible{outline:2px solid #000;outline-offset:-2px}
.tl-row .main{flex:1;min-width:0} .tl-row .nm{font-weight:600;color:var(--fg1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .tl-row .un{font-size:12px;line-height:16px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-foot{display:flex;align-items:center;gap:16px;color:var(--fg3)}
.chk{display:inline-flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap;color:var(--fg2)}
.card{border:1px solid var(--s2);border-radius:8px;display:flex;flex-direction:column;min-height:0;background:var(--bg1)}
.card-h{display:flex;align-items:center;gap:12px;height:56px;padding:0 12px 0 16px;border-bottom:1px solid var(--s3);flex:none}
.card-t{font-size:14px;font-weight:600;flex:0 0 auto;display:flex;align-items:center;gap:8px;white-space:nowrap}
.card-h .input{flex:0 1 280px;min-width:160px;margin-left:auto}
.count{font-size:12px;line-height:20px;font-weight:600;color:var(--brand);background:var(--brand-bg);border-radius:10px;padding:0 8px;flex:none}
.card-s{display:flex;align-items:center;gap:12px;height:44px;padding:0 16px;border-bottom:1px solid var(--s3);color:var(--fg2);flex:none}
.switch{width:40px;height:20px;border-radius:10px;border:1px solid var(--fg3);background:var(--bg1);position:relative;padding:0;cursor:pointer;flex:none;transition:background .15s,border-color .15s}
.switch i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--fg3);transition:transform .15s,background .15s}
.switch[aria-checked=true]{background:var(--brand);border-color:var(--brand)} .switch[aria-checked=true] i{background:#fff;transform:translateX(20px)}
.switch:disabled{opacity:.4;cursor:default} .card-s label{cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0} .card-s .link{white-space:nowrap;flex:none}
.list{flex:1;overflow:auto;min-height:0}
.row{display:flex;align-items:center;gap:12px;height:53px;padding:0 16px;border-bottom:1px solid var(--s3);cursor:pointer;transition:background .08s}
.row:hover{background:var(--bg3)} .row.on{background:var(--brand-bg)} .row.on:hover{background:#dcebfb} .row:focus-visible{outline:2px solid #000;outline-offset:-2px}
.row .main{flex:1;min-width:0} .row .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .row .un{font-size:12px;line-height:16px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .side{text-align:right;font-size:12px;color:var(--fg3);line-height:16px;flex:none;max-width:45%} .row .side div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list.enter .row{animation:fade .15s ease-out}
.tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;background:var(--bg4);color:var(--fg2);font-size:12px;font-weight:600;line-height:16px;vertical-align:1px}
.sk{display:flex;align-items:center;gap:12px;height:53px;padding:0 16px;border-bottom:1px solid var(--s3)}
.sk i,.sk-row i{display:block;border-radius:5px;background:linear-gradient(90deg,var(--bg3) 0,var(--bg4) 50%,var(--bg3) 100%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;padding:48px 24px;color:var(--fg3)}
.empty .ic{width:48px;height:48px;border-radius:24px;display:grid;place-items:center;background:var(--bg3);color:var(--fg3);margin-bottom:4px}
.empty .ic.ok{background:var(--green-bg);color:var(--green)} .empty .ic.bad{background:var(--red-bg);color:var(--red)}
.empty b{color:var(--fg1);font-size:16px;line-height:22px;font-weight:600} .empty .acts{display:flex;gap:8px;margin-top:8px}
.t-master{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--fg1)}
.types-body{flex:1;overflow:auto;padding:8px 16px 12px;min-height:0;scrollbar-gutter:stable}
.t-sec{margin-top:8px} .t-sec:first-child{margin-top:0} .t-sec h4{margin:0 0 2px;font-size:12px;line-height:16px;font-weight:600;color:var(--fg2)}
.t-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.t-item{display:flex;align-items:center;gap:8px;padding:3px 6px;margin:0 -6px;border-radius:4px;cursor:pointer;white-space:nowrap} .t-item:hover{background:var(--bg3)}
.t-note{display:flex;align-items:flex-start;gap:8px;margin:0 0 8px;padding:8px 10px;border-radius:4px;background:var(--brand-bg);color:var(--fg2);font-size:12px;line-height:16px} .t-note svg{flex:none;color:var(--brand);margin-top:1px}
.card-t .opt{font-weight:400;font-size:12px;color:var(--fg3)}
#scanBtn{min-width:96px}
/* menus */
.menu-wrap{position:relative;flex:none}
.menu{position:absolute;right:0;top:36px;z-index:5;min-width:240px;background:var(--bg1);border-radius:4px;box-shadow:0 0 2px rgba(0,0,0,.12),0 8px 16px rgba(0,0,0,.14);padding:4px;animation:rise .12s ease-out}
.menu .mi{display:flex;flex-direction:column;align-items:flex-start;width:100%;min-height:32px;border:0;background:none;padding:6px 10px;border-radius:4px;cursor:pointer;text-align:left}
.menu .mi:hover,.menu .mi:focus-visible{background:var(--bg3);outline:0} .menu .mi small{color:var(--fg3);font-size:12px;line-height:16px}
#savedMenu{min-width:340px;max-width:400px;max-height:360px;overflow:auto}
.s-item{display:flex;align-items:center;gap:8px;min-height:48px;padding:4px 4px 4px 8px;border-radius:4px;cursor:pointer} .s-item:hover{background:var(--bg3)} .s-item:focus-visible{outline:2px solid #000;outline-offset:-2px}
.s-item .ck{width:20px;flex:none;color:var(--brand);display:grid;place-items:center} .s-item .tx{flex:1;min-width:0}
.s-item .tx div{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .s-item .tx small{display:block;font-size:12px;line-height:16px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s-item .s-del{width:28px;height:28px;color:var(--fg3)} .s-item .s-del:hover{color:var(--red);background:var(--red-bg)}
.m-empty{padding:12px;font-size:12px;line-height:16px;color:var(--fg3);max-width:320px}
/* results */
.res-head{display:flex;align-items:center;gap:8px;padding:16px 24px 12px;flex:none}
.res-title{min-width:0;flex:1} .res-title .sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.progress{height:2px;background:var(--s3);overflow:hidden;flex:none} .progress div{height:100%;width:0;background:var(--brand);transition:width .25s ease-out,opacity .2s}
.progress.off{background:transparent} .progress.off div{opacity:0}
.tools{display:flex;align-items:center;gap:12px;height:44px;padding:0 24px 12px;flex:none;box-sizing:content-box}
.tools .input{width:300px;flex:none}
.chips{display:flex;gap:6px;flex:0 1 auto;min-width:0;overflow:hidden}   /* More comes right after the last bubble */
.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--s1);background:var(--bg1);color:var(--fg2);font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;flex:none;transition:background .1s,border-color .1s}
.chip:focus-visible{outline-offset:-3px}
.chip:hover{background:var(--bg3)} .chip[aria-pressed=true],.chip.on{background:var(--brand-bg);border-color:var(--brand);color:var(--brand)}
.chip .n{font-weight:400;color:var(--fg3)} .chip[aria-pressed=true] .n,.chip.on .n{color:var(--brand)} .chip:disabled{cursor:default;color:#bdbdbd}
.chip.more svg{color:var(--fg3)} #moreMenu{min-width:240px;max-height:340px;overflow:auto;left:auto;right:0}
#moreMenu .mi{flex-direction:row;align-items:center;justify-content:space-between;gap:16px} #moreMenu .mi small{flex:none}
.tools .link{white-space:nowrap;flex:none}
.step{display:flex;align-items:center;gap:8px;flex:1;min-width:0;color:var(--fg2);white-space:nowrap} .step .spin{color:var(--brand)}
.step .txt{overflow:hidden;text-overflow:ellipsis;min-width:0} .step .pct{color:var(--fg3);flex:none}
.banner{display:flex;align-items:center;gap:10px;margin:0 24px 12px;padding:8px 12px;border-radius:4px;border:1px solid var(--s2);background:var(--bg3);color:var(--fg2);flex:none}
.banner .ic{flex:none;color:var(--fg3)} .banner.warn{background:var(--amber-bg);border-color:var(--amber-s)} .banner.warn .ic{color:var(--amber)}
.banner .txt{flex:1;min-width:0}
details summary{cursor:pointer;color:#115ea3;list-style:none;display:inline-flex;align-items:center;gap:4px} details summary::-webkit-details-marker{display:none}
details summary svg{transform:rotate(-90deg);transition:transform .1s} details[open] summary svg{transform:none}
.grid-wrap{flex:1;overflow:auto;min-height:0;border-top:1px solid var(--s2);scroll-padding-top:45px}
table.grid{border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed;min-width:1000px}   /* a narrow window scrolls sideways instead of losing a column */
.grid th{position:sticky;top:0;z-index:1;background:var(--bg1);text-align:left;font-weight:600;color:var(--fg1);padding:0 12px;height:44px;border-bottom:1px solid var(--s2);white-space:nowrap;vertical-align:middle}
.grid td{padding:8px 12px;height:52px;border-bottom:1px solid var(--s3);vertical-align:middle}
.grid th.c,.grid td.c{padding:0 0 0 24px} .grid th.o,.grid td.o{padding:0 16px 0 0;text-align:right} .grid td.o{white-space:nowrap}
.grid th.f{padding:0 4px}
.cr{position:absolute;top:0;bottom:0;right:0;width:9px;cursor:col-resize;z-index:2;touch-action:none}
.cr::after{content:'';position:absolute;right:3px;top:12px;bottom:12px;width:2px;border-radius:1px;background:transparent;transition:background .1s}
.grid thead:hover .cr::after{background:var(--s1)} .grid thead .cr:hover::after,.cr.on::after{background:var(--brand)}
.app.colsizing{pointer-events:auto;cursor:col-resize} .app.colsizing .panel{user-select:none} .app.colsizing .panel *{cursor:col-resize!important}
.hb{display:flex;align-items:center;gap:4px;width:100%;height:32px;padding:0 8px;border:0;border-radius:4px;background:none;font-weight:600;color:var(--fg1);cursor:pointer;text-align:left;min-width:0}
.hb:hover{background:var(--bg3)} .hb[aria-expanded=true]{background:var(--bg4)} .hb:disabled{cursor:default} .hb:disabled:hover{background:none}
.hb .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0} .hb .ind{display:flex;align-items:center;gap:2px;flex:none;color:var(--fg3)} .hb .ind .on{color:var(--brand);display:grid}
.pop{position:absolute;z-index:15;width:300px;display:flex;flex-direction:column;background:var(--bg1);border-radius:6px;box-shadow:0 0 2px rgba(0,0,0,.12),0 8px 16px rgba(0,0,0,.14);padding:4px 0;animation:rise .12s ease-out}
.pop .mi{display:flex;align-items:center;gap:8px;min-height:32px;border:0;background:none;padding:0 8px;margin:0 4px;border-radius:4px;cursor:pointer;text-align:left;flex:none}
.pop .mi:hover,.pop .mi:focus-visible{background:var(--bg3);outline:0} .pop .mi .ck{width:16px;display:grid;color:var(--brand)} .pop .mi .si{display:grid;color:var(--fg3)}
.pop .sep{height:1px;background:var(--s2);margin:4px 0;flex:none} .pop .input{margin:4px 12px;flex:none}
.pop-list{flex:1;min-height:64px;overflow:auto;padding:2px 4px}
.pv{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 8px;border-radius:4px;cursor:pointer} .pv:hover{background:var(--bg3)}
.pv .v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .pv .n{color:var(--fg3);font-size:12px;flex:none} .pv.all{font-weight:600}
.pop-more{padding:6px 12px;font-size:12px;line-height:16px;color:var(--fg3)}
.pop-foot{display:flex;align-items:center;gap:8px;padding:8px 12px 4px;border-top:1px solid var(--s2);margin-top:4px;flex:none}
.grid tbody tr{cursor:pointer} .grid tbody tr:hover td{background:var(--bg3)} .grid tbody tr.sel td{background:var(--brand-bg)} .grid tbody tr.sel:hover td{background:#dcebfb}
.grid tbody tr.busy td{background:var(--brand-bg)}
.grid tbody tr.done td{color:var(--fg4)} .grid tbody tr.done .nm{text-decoration:line-through;color:var(--fg4)}
.grid .one{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid a.nm{display:block;color:var(--fg1);font-weight:600;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .grid a.nm:hover{color:var(--brand);text-decoration:underline}
.grid span.nm{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid .sc,.grid .lg{font-size:12px;line-height:16px;color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tags{display:flex;gap:4px;align-items:center;overflow:hidden;min-width:0}
.chg{display:flex;align-items:center;width:100%;min-height:28px;border:0;background:none;padding:2px 6px;margin:-2px -6px;border-radius:4px;cursor:pointer;text-align:left;color:inherit}
.chg:hover{background:var(--bg4)} .chg:hover .ptag{background:var(--bg1)} .chg{overflow:hidden} .chg>.quiet{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ptag{flex:0 1 auto;min-width:24px;height:20px;line-height:20px;padding:0 6px;border-radius:4px;background:var(--bg3);color:var(--fg2);font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.more{font-size:12px;color:var(--fg3);white-space:nowrap;flex:none}
.tags.measure .ptag{flex:none;max-width:none}   /* measured at their own width (they would shrink to the cell) */
.open{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:4px;color:var(--fg3);vertical-align:middle} .open:hover{background:var(--bg4);color:var(--brand)} button.open{border:0;background:none;padding:0;cursor:pointer}
.pill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap;background:var(--bg3);color:var(--fg2);flex:none}
.pill.ok{background:var(--green-bg);color:var(--green)} .pill.bad{background:var(--red-bg);color:var(--red)} .pill.amb{background:var(--amber-bg);color:var(--amber);box-shadow:inset 0 0 0 1px var(--amber-s)}
.stat{display:flex;align-items:center;gap:8px;min-width:0} .why{font-size:12px;color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite;flex:none;display:inline-block}
.donec{color:var(--green);display:grid;width:16px} .nodel{color:var(--fg4);display:grid;width:16px;cursor:help}
.sk-row td{height:52px}
.sheet{position:absolute;left:0;right:0;top:56px;bottom:0;z-index:12;background:var(--bg1);display:flex;flex-direction:column;animation:slideIn .18s cubic-bezier(.1,.9,.2,1)}
.sh-head{display:flex;align-items:center;gap:8px;padding:12px 24px 12px 16px;flex:none}
.sh-title{flex:1;min-width:0} .sh-title h2{font-size:18px;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh-title .sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:16px}
.sh-pos{color:var(--fg3);font-size:12px;white-space:nowrap;min-width:56px;text-align:center}
.tabs{display:flex;gap:4px;padding:0 14px;border-bottom:1px solid var(--s2);flex:none}
.tab{position:relative;height:40px;padding:0 10px;border:0;background:none;color:var(--fg2);cursor:pointer}
.tab:hover{color:var(--fg1)} .tab[aria-selected=true]{color:var(--fg1);font-weight:600}
.tab[aria-selected=true]::after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;height:3px;border-radius:2px;background:var(--brand)}
.sh-tools{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;padding:12px 24px;border-bottom:1px solid var(--s3);flex:none}
.sh-tools:empty{display:none}
.sh-body{flex:1;min-height:0;overflow:auto;padding:16px 24px 24px}
.fld{display:inline-flex;align-items:center;gap:8px;color:var(--fg2);white-space:nowrap}
.sel{height:32px;max-width:280px;border:1px solid var(--s1);border-bottom-color:var(--fg3);border-radius:4px;font:inherit;color:var(--fg1);padding:0 32px 0 12px;cursor:pointer;appearance:none;-webkit-appearance:none;text-overflow:ellipsis;
  background:var(--bg1) no-repeat right 8px center/16px url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><path d='M6 8l4 4 4-4' fill='none' stroke='%23616161' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>")}
.sel.old,.lchip.old{box-shadow:inset 3px 0 0 #c50f1f} .sel.new,.lchip.new{box-shadow:inset 3px 0 0 #0e700e}
.lchip{display:inline-block;height:32px;line-height:30px;max-width:300px;padding:0 12px;border:1px solid var(--s2);border-radius:4px;background:var(--bg2);color:var(--fg1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.sel:focus-visible{outline:2px solid #000;outline-offset:1px}
.seg{display:inline-flex;border:1px solid var(--s1);border-radius:4px;overflow:hidden;flex:none}
.seg button{height:30px;padding:0 12px;border:0;background:var(--bg1);cursor:pointer;color:var(--fg2);white-space:nowrap} .seg button+button{border-left:1px solid var(--s1)}
.seg button:hover{background:var(--bg3)} .seg button[aria-pressed=true]{background:var(--brand-bg);color:var(--brand);font-weight:600}
.props{display:flex;flex-direction:column;gap:12px}
.prop{border:1px solid var(--s2);border-radius:6px;overflow:hidden;flex:none}
.prop-h{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:0 12px;border:0;background:var(--bg2);text-align:left;cursor:pointer;color:var(--fg1)}
.prop-h:hover{background:var(--bg3)} .prop-h .k{font:600 13px/18px "Cascadia Mono",Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.prop-h .cv{display:grid;transform:rotate(-90deg);transition:transform .1s;color:var(--fg3)} .prop.ex .prop-h .cv{transform:none}
.prop-b{border-top:1px solid var(--s2)}
.kv{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:6px 16px;padding:10px 12px;align-items:baseline}
.kv .lb{font-size:12px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kv .val{font:12px/18px "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:2px 6px;border-radius:3px}
.kv .val.old{background:#fdeaea} .kv .val.new{background:#e9f7ec} .kv i{color:var(--fg3);font-style:normal}
.legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:6px 12px;font-size:12px;color:var(--fg2);border-bottom:1px solid var(--s3);background:var(--bg1)}
.legend .lo{color:#a4262c} .legend .ln2{color:#0e700e} .legend .link{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.diff{font:12px/18px "Cascadia Mono",Consolas,monospace;max-height:560px;overflow:auto;color:var(--fg1)}
.dl{display:grid;grid-template-columns:44px 44px 18px minmax(0,1fr)}
.dl .ln,.sr2 .ln{color:var(--fg3);text-align:right;padding-right:8px;user-select:none} .dl .sg{color:var(--fg3);user-select:none}
.dl .tx,.sr2 .tx{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;padding-right:8px}
.dl.del,.sr2 .del{background:#fdeaea} .dl.add,.sr2 .add{background:#e9f7ec} .sr2 .nil{background:var(--bg3)}
.crm{color:var(--fg3)}
.dl.del mark,.sr2 .del mark{background:#f6c3c3;color:inherit;border-radius:2px} .dl.add mark,.sr2 .add mark{background:#b6e3bf;color:inherit;border-radius:2px}
.sr2{display:grid;grid-template-columns:44px minmax(0,1fr) 44px minmax(0,1fr)} .sr2 .tx:nth-child(2){border-right:1px solid var(--s2)}
.fold{display:flex;align-items:center;gap:6px;width:100%;border:0;background:var(--brand-bg);color:#115ea3;text-align:left;padding:3px 12px 3px 60px;cursor:pointer;font:12px/18px "Segoe UI",-apple-system,sans-serif}
.fold:hover{background:#dcebfb}
.imgs{display:flex;gap:24px;flex-wrap:wrap;padding:12px}
.imgs figure{margin:0;display:flex;flex-direction:column;gap:6px} .imgs figcaption{font-size:12px;color:var(--fg3)}
.imgs img{max-width:280px;max-height:200px;border:1px solid var(--s2);background:repeating-conic-gradient(#f0f0f0 0 25%,#fff 0 50%) 0 0/16px 16px}
.code{font:12px/18px "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px 16px;background:var(--bg2);border:1px solid var(--s2);border-radius:6px;color:var(--fg2)}
.code .k{color:#a4262c} .code .s{color:#0f548c} .code .n{color:#0e700e} .code .b{color:#8a3707}
table.lt{border-collapse:collapse;width:100%} .lt .one{white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .lt .lg{font-size:12px;line-height:16px;color:var(--fg3)} .lt .nw{white-space:nowrap} .lt th{text-align:left;font-weight:600;padding:8px 12px;border-bottom:1px solid var(--s2);white-space:nowrap;color:var(--fg1)}
.lt td{padding:10px 12px;border-bottom:1px solid var(--s3);vertical-align:middle} .lt .acts{display:flex;gap:8px;justify-content:flex-end;white-space:nowrap}
.ct{margin-bottom:16px} .ct h4{margin:0 0 8px;font-size:14px;font-weight:600}
.sh-note{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:4px;background:var(--bg3);color:var(--fg2);margin-bottom:12px}
/* dialog and toasts */
.scrim{position:absolute;inset:0;z-index:20;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:24px;animation:fade .12s ease-out}
.dialog{width:min(560px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--bg1);border-radius:8px;box-shadow:0 0 2px rgba(0,0,0,.12),0 32px 64px rgba(0,0,0,.24);padding:24px;gap:16px;animation:rise .18s cubic-bezier(.1,.9,.2,1)}
.dialog h3{margin:0;font-size:20px;line-height:28px;font-weight:600}
.dlg-body{color:var(--fg2);overflow:auto;min-height:0;display:flex;flex-direction:column;gap:12px} .dlg-body p{margin:0}
.dlg-actions{display:flex;justify-content:flex-end;gap:8px}
.dlg-list{border:1px solid var(--s2);border-radius:4px;max-height:220px;overflow:auto}
.dlg-list div{display:flex;gap:12px;align-items:baseline;padding:8px 12px;border-bottom:1px solid var(--s3)} .dlg-list div:last-child{border-bottom:0}
.dlg-list .t{color:var(--fg3);flex:none;width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .dlg-list .n{font-weight:600;color:var(--fg1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dlg-list .s{font-size:12px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.field label{display:block;font-weight:600;margin-bottom:4px;color:var(--fg1)} .field .hint{font-size:12px;line-height:16px;color:var(--fg3);margin-top:8px}
.note{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-radius:4px;background:var(--red-bg);color:var(--red);border:1px solid var(--red-s)} .note.amb{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-s)} .note svg{flex:none;margin-top:2px}
.err-box{margin-top:8px;padding:8px 10px;border-radius:4px;background:var(--bg3);font:12px/16px "Cascadia Mono",Consolas,monospace;color:var(--fg2);overflow-wrap:anywhere;text-align:left;max-width:640px}
.toasts{position:absolute;right:24px;bottom:80px;z-index:30;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
.toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;width:360px;max-width:calc(100% - 48px);padding:12px;border-radius:4px;background:var(--bg1);color:var(--fg1);box-shadow:0 0 2px rgba(0,0,0,.12),0 8px 16px rgba(0,0,0,.14);animation:rise .18s ease-out}
.toast.out{animation:toastOut .15s ease-in forwards} .toast .ic{flex:none;margin-top:2px} .toast.ok .ic{color:var(--green)} .toast.warn .ic{color:var(--amber)}
.toast .txt{flex:1;min-width:0} .toast .act{display:block;margin-top:4px} .toast .x{width:24px;height:24px;border:0;border-radius:4px;background:none;display:grid;place-items:center;color:var(--fg3);cursor:pointer;flex:none} .toast .x:hover{background:var(--bg3);color:var(--fg1)}
.mini{position:fixed;right:24px;bottom:24px;z-index:2;pointer-events:auto;display:flex;align-items:center;gap:10px;height:44px;padding:0 16px 0 14px;border-radius:22px;border:1px solid #e0e0e0;background:#fff;color:#242424;
  box-shadow:0 0 2px rgba(0,0,0,.12),0 8px 16px rgba(0,0,0,.14);font:600 14px/20px "Segoe UI",-apple-system,BlinkMacSystemFont,Roboto,sans-serif;cursor:pointer;animation:rise .18s ease-out}
.mini:hover{background:#f5f5f5} .mini .spin{color:#0f6cbd;width:16px;height:16px} .mini .ok{color:#0e700e;display:grid} .mini small{font-weight:400;color:#616161}
@container (max-width:900px){.card-t .opt,#tblBtn svg,#tblCount{display:none!important}.cols{grid-template-columns:minmax(0,1fr) 280px}.t-grid{grid-template-columns:1fr}.tools .input{width:220px}.sh-head .btn .lbl{display:none}.sh-head .btn{padding:0 8px}}
@media (prefers-reduced-motion:reduce){.app,.panel,.dialog,.scrim,.menu,.toast,.pop,.sheet,.list.enter .row{animation:none}.sk i,.sk-row i{animation:none}.progress div{transition:none}}`
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none'   // only the window itself takes clicks
  const root = host.attachShadow({ mode: 'open' })
  try { const s = new CSSStyleSheet(); s.replaceSync(STYLE); root.adoptedStyleSheets = [s] } catch { const st = document.createElement('style'); st.textContent = STYLE; root.appendChild(st) }
  const envBadge = IS_PROD ? '<span class="badge prod">Production</span>' : IS_DEV ? '<span class="badge dev" title="Deleting is turned off in development environments">Development</span>' : ''
  const app = document.createElement('div')
  app.className = 'app'
  app.innerHTML = `
  <div class="win" id="win">
  <div class="panel" role="dialog" aria-modal="false" aria-labelledby="ttl">
    <div class="top" id="top" title="Drag to move. Double-click to maximize."><div class="logo">${icon('layers', 18)}</div><h1 id="ttl" title="Unmanaged layer scanner ${VERSION}">Unmanaged layers</h1><span class="badge" title="${esc(ORIGIN)}">${esc(ORG)}</span>${envBadge}<span class="spacer"></span>
      <div class="tbtns"><button class="btn subtle icon" id="maxBtn" title="Maximize" aria-label="Maximize">${icon('maximize', 20)}</button>
      <button class="btn subtle icon" id="close" title="Close (Esc)" aria-label="Close">${icon('close', 20)}</button></div></div>
    <section class="view" id="vPick">
      <div class="pick-head"><div class="ph-text"><h2>Choose what to check</h2><p class="sub">Choose managed solutions and select Scan to find their components with unmanaged customizations (an Active layer).</p></div>
        <div class="menu-wrap"><button class="btn" id="savedBtn" aria-haspopup="menu" aria-expanded="false">${icon('save', 20)} Saved selections ${icon('chevron', 16)}</button><div class="menu" id="savedMenu" role="menu" aria-label="Saved selections" hidden></div></div></div>
      <div class="cols">
        <div class="card">
          <div class="card-h"><div class="card-t">Managed solutions <span class="count" id="solCount" hidden></span></div>
            <label class="input">${icon('search')}<input type="search" id="solSearch" placeholder="Search solutions" aria-label="Search solutions"></label></div>
          <div class="card-s"><button class="switch" id="showAll" role="switch" aria-checked="false" aria-labelledby="showAllL"><i></i></button><label for="showAll" id="showAllL">Show Microsoft and hidden solutions</label>
            <span class="spacer"></span><button class="link" id="selAll">Select all shown</button><button class="link" id="selNone">Clear</button></div>
          <div class="list" id="solList" role="listbox" aria-multiselectable="true" aria-label="Managed solutions"></div>
        </div>
        <div class="rcol">
          <div class="card types">
            <div class="card-h"><div class="card-t">Object types <span class="count" id="typeCount" hidden></span></div><span class="spacer"></span><label class="t-master"><input type="checkbox" id="typesAll" checked> All</label></div>
            <div class="types-body" id="typeList"></div>
          </div>
          <div class="card tables">
            <div class="card-h"><div class="card-t">Limit to tables <span class="opt">Optional</span><span class="count" id="tblCount" hidden></span></div><span class="spacer"></span><button class="btn" id="tblBtn" disabled>${icon('table', 20)} Choose tables</button></div>
            <div class="tb-body" id="tblBody"></div>
          </div>
        </div>
      </div>
      <div class="bar"><div class="msg" id="pickMsg"></div><span class="spacer"></span>
        <button class="btn" id="toResults" hidden>${icon('back', 20)} Back to results</button>
        <button class="btn" id="saveBtn" disabled>${icon('save', 20)} Save selection</button>
        <button class="btn primary" id="scanBtn" disabled>${icon('search', 20)} Scan</button></div>
    </section>
    <section class="view" id="vRes" hidden>
      <div class="res-head"><div class="res-title"><h2 id="resTitle" tabindex="-1">Scanning…</h2><div class="sub" id="st"></div></div>
        <button class="btn" id="stopScan" hidden>Stop scan</button>
        <button class="btn subtle" id="change">${icon('back', 20)} Change selection</button>
        <button class="btn" id="again">${icon('refresh', 20)} Scan again</button>
        <div class="menu-wrap" id="exportWrap"><button class="btn" id="exportBtn" aria-haspopup="menu" aria-expanded="false">${icon('download', 20)} Export ${icon('chevron', 16)}</button>
          <div class="menu" id="exportMenu" role="menu" aria-label="Export" hidden>
            <button class="mi" role="menuitem" tabindex="-1" id="csv">Excel (CSV)<small>The rows shown</small></button>
            <button class="mi" role="menuitem" tabindex="-1" id="layersBtn">All layers (CSV)<small>Every layer of each component shown, with its publisher and time</small></button>
            <button class="mi" role="menuitem" tabindex="-1" id="json">Full details (JSON)<small>Everything the scan found</small></button>
            <button class="mi" role="menuitem" tabindex="-1" id="logBtn" hidden>Deletion log (CSV)<small>Every deletion of this session, with the removed changes</small></button></div></div></div>
      <div class="progress off" id="prog" role="progressbar" aria-label="Scan progress" aria-valuemin="0" aria-valuemax="100"><div id="pg"></div></div>
      <div class="tools" id="resTools"><label class="input">${icon('search')}<input type="search" id="q" placeholder="Search by name, table or change" aria-label="Search the results"></label><div class="chips" id="chips" role="group" aria-label="Filter by type"></div><div class="menu-wrap" id="moreWrap" hidden><button class="chip more" id="moreBtn" aria-haspopup="menu" aria-expanded="false"></button><div class="menu" id="moreMenu" role="menu" aria-label="More types" hidden></div></div><button class="link" id="fClear" hidden>Clear filters</button><div class="step" id="step" hidden><span class="spin"></span><span class="txt" id="stepTxt"></span><span class="pct" id="stepPct"></span></div></div>
      <div id="banners"></div>
      <div class="grid-wrap" id="gridWrap"><table class="grid" id="grid" aria-label="Components with an unmanaged layer"><colgroup><col style="width:48px"><col style="width:172px"><col style="width:22%"><col style="width:17%"><col style="width:15%"><col><col style="width:88px"></colgroup>
        <thead><tr><th class="c"><input type="checkbox" id="all" aria-label="Select all shown"></th>${[['type', 'Type'], ['name', 'Name'], ['table', 'Table'], ['solution', 'Managed solution'], ['changed', 'What changed']].map(([c, t]) => `<th class="f"><button class="hb" data-col="${c}" aria-haspopup="dialog" aria-expanded="false" title="Sort and filter ${t.toLowerCase()}"><span class="l">${t}</span><span class="ind"></span></button>${c === 'changed' ? '' : `<span class="cr" data-c="${c}" title="Drag to resize. Double-click to fit the contents." aria-hidden="true"></span>`}</th>`).join('')}<th class="o"><span class="sr">Actions</span></th></tr></thead><tbody id="rows"></tbody></table>
        <div class="empty" id="empty" hidden></div></div>
      <div class="bar" id="selBar"><div class="msg" id="selMsg"></div><span class="spacer"></span>
        <button class="btn subtle" id="selClear" hidden>Clear selection</button>
        <button class="btn" id="stopBtn" hidden title="Stop after the component being deleted now">Stop deleting</button>
        <button class="btn danger" id="delBtn" disabled ${IS_DEV ? 'hidden' : ''}>${icon('trash', 20)} Delete unmanaged layer</button></div>
    </section>
    <section class="sheet" id="sheet" hidden aria-labelledby="shTitle">
      <div class="sh-head"><button class="btn subtle icon" id="shBack" title="Back to the results (Esc)" aria-label="Back to the results">${icon('back', 20)}</button>
        <div class="sh-title"><h2 id="shTitle" tabindex="-1"></h2><div class="sub" id="shSub"></div></div>
        <button class="btn subtle icon" id="shPrev" title="Previous component (Alt+Up)" aria-label="Previous component">${icon('up', 20)}</button><span class="sh-pos" id="shPos"></span>
        <button class="btn subtle icon" id="shNext" title="Next component (Alt+Down)" aria-label="Next component">${icon('down', 20)}</button>
        <a class="btn" id="shOpen" target="_blank" rel="noopener">${icon('open', 20)}<span class="lbl">Solution layers</span></a>
        <button class="btn danger-o" id="shDel" ${IS_DEV ? 'hidden' : ''}>${icon('trash', 20)}<span class="lbl">Delete unmanaged layer</span></button></div>
      <div class="tabs" role="tablist" id="shTabs" aria-label="Details">
        <button class="tab" role="tab" data-tab="compare" id="tab-compare" aria-controls="shPanel">What changed</button>
        <button class="tab" role="tab" data-tab="layers" id="tab-layers" aria-controls="shPanel">Layers</button>
        <button class="tab" role="tab" data-tab="json" id="tab-json" aria-controls="shPanel">JSON</button></div>
      <div id="shPanel" role="tabpanel" style="display:flex;flex-direction:column;flex:1;min-height:0"><div class="sh-tools" id="shTools"></div><div class="sh-body" id="shBody"></div></div>
    </section>
    <div class="pop" id="pop" role="dialog" hidden>
      <button class="mi" data-sort="1"><span class="ck"></span><span class="si">${icon('sortUp', 16)}</span>Sort A to Z</button>
      <button class="mi" data-sort="-1"><span class="ck"></span><span class="si">${icon('sortDown', 16)}</span>Sort Z to A</button>
      <button class="mi" id="popFit"><span class="ck"></span><span class="si">${icon('maximize', 16)}</span>Fit to contents</button>
      <button class="mi" id="popReset" hidden><span class="ck"></span><span class="si">${icon('refresh', 16)}</span>Reset column widths</button>
      <div class="sep"></div>
      <label class="input">${icon('search')}<input type="search" id="popQ" placeholder="Search" aria-label="Search the values" autocomplete="off"></label>
      <div class="pop-list" id="popList"></div>
      <div class="pop-foot"><button class="btn subtle" id="popClear">Clear filter</button><span class="spacer"></span><button class="btn primary" id="popDone">Done</button></div>
    </div>
    <div class="scrim" id="dlg" hidden><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgTitle" aria-describedby="dlgBody"><h3 id="dlgTitle"></h3><div class="dlg-body" id="dlgBody"></div><div class="dlg-actions" id="dlgActions"></div></div></div>
    <div class="toasts" id="toasts"></div>
    <div class="sr" id="live" aria-live="polite"></div>
  </div>${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<div class="rz ${d}" data-d="${d}" aria-hidden="true"></div>`).join('')}</div>`
  root.appendChild(app)
  const mini = document.createElement('button')
  mini.className = 'mini'; mini.hidden = true
  root.appendChild(mini)
  document.body.appendChild(host)
  for (const ev of ['keydown', 'keyup', 'keypress']) host.addEventListener(ev, (e) => e.stopPropagation())   // keep the app's shortcuts out of the window
  const $ = (id) => root.getElementById(id)

  // ---- state
  let view = 'pick', result = null, busy = false, scanning = false, deleting = null, scanError = ''
  let allSolutions = [], solState = 'loading', solError = '', chosen = new Set(), typesSel = new Set(GROUPS), showAll = false, activeSaved = '', pickReason = ''
  const selected = new Set(), status = new Map(), keepDeleted = new Set()   // status: key -> { state, detail }
  let lastLog = null, firstList = true, finishing = false
  let tablesSel = new Set(), tableList = null, tablesPromise = null   // chosen tables (logical names; none: all), the environment's tables
  const logRows = []   // every deletion of this session (scans do not clear it)
  const LOG_HEAD = 'Result,Type,Display name,Schema name,Table,Managed solution,Component id,Detail,Unmanaged changes per place (with result),Deleted on'
  const logText = (rows) => '\ufeff' + [LOG_HEAD, ...rows].join('\r\n')
  // The object types offered: all of them, or, with tables chosen, only those that can belong to a table (the others
  // are not listed then, and not checked).
  const shownGroups = () => GROUPS.filter((g) => groupOn(g))
  const typesOn = () => shownGroups().filter((g) => typesSel.has(g))
  const allTypes = () => typesOn().length === shownGroups().length
  const typesChosen = () => (allTypes() ? [] : typesOn())
  const tablesChosen = () => [...tablesSel].sort()
  const setTables = (list) => { tablesSel = new Set((Array.isArray(list) ? list : []).filter((t) => typeof t === 'string' && /^[a-z0-9_]{1,128}$/i.test(t)).map(lc)) }
  // The last choice is remembered per environment; saved selections (a name, solutions and object types) are kept
  // in this browser for this site: on the maker portal they are shared by all environments.
  const STORE = `unmanagedLayerScanner:${ORG}:solutions`, SAVED = 'unmanagedLayerScanner:selections'
  const setTypes = (list) => { const t = (list || []).filter((g) => GROUPS.includes(g)); typesSel = new Set(t.length ? t : GROUPS) }
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || '[]')
    if (Array.isArray(v)) chosen = new Set(strings(v))
    else if (v && Array.isArray(v.solutions)) { chosen = new Set(strings(v.solutions)); setTypes(strings(v.pick).length ? strings(v.pick) : strings(v.types)); setTables(v.tables) }
  } catch { }
  const loadSaved = () => {
    try {
      const v = JSON.parse(localStorage.getItem(SAVED) || '[]')
      return (Array.isArray(v) ? v : []).filter((x) => x && typeof x.name === 'string' && x.name.trim() && Array.isArray(x.solutions))
        .map((x) => ({ name: x.name.slice(0, 60), solutions: strings(x.solutions), types: strings(x.types).filter((g) => GROUPS.includes(g)), pick: strings(x.pick).filter((g) => GROUPS.includes(g)), tables: strings(x.tables).filter((t) => /^[a-z0-9_]{1,128}$/i.test(t)).map(lc), savedOn: typeof x.savedOn === 'string' ? x.savedOn.slice(0, 10) : '' }))
    } catch { return [] }
  }
  const storeSaved = (list) => { try { localStorage.setItem(SAVED, JSON.stringify(list)); return true } catch { return false } }
  const picked = () => allSolutions.filter((s) => chosen.has(s.unique))
  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`
  const typesText = (t) => (!t.length ? 'All object types' : t.length > 3 ? `${t.length} object types` : t.join(', '))
  const tableName = (n) => { const t = tableList && tableList.find((x) => x.logical === n); return t ? t.name : n }
  const tablesText = (t) => (!t || !t.length ? 'All tables' : t.length > 2 ? `${t.length} tables` : `${t.length > 1 ? 'Tables' : 'Table'}: ${t.map(tableName).join(', ')}`)
  const announce = (t) => { $('live').textContent = ''; setTimeout(() => { $('live').textContent = t }, 50) }

  // ---- dialogs and toasts
  let dlgClose = null
  function openDialog({ title, body, actions, wide = false }) {
    const opener = root.activeElement
    closePop()
    root.querySelector('.dialog').classList.toggle('wide', wide)
    $('dlgTitle').textContent = title
    $('dlgBody').innerHTML = body
    $('dlgActions').innerHTML = actions.map((a) => `<button class="btn ${a.kind || ''}" id="${a.id}">${a.label}</button>`).join('')
    for (const id of ['top', 'vPick', 'vRes', 'sheet']) $(id).inert = true
    $('dlg').hidden = false
    dlgClose = () => {
      $('dlg').hidden = true; dlgClose = null
      for (const id of ['top', 'vPick', 'sheet']) $(id).inert = false
      $('vRes').inert = !$('sheet').hidden   // stays inert behind the details
      const back = opener && opener.isConnected && !opener.disabled && !opener.closest('[hidden]') ? opener : view === 'pick' ? $('solSearch') : $('resTitle')
      setTimeout(() => back.focus(), 0)
    }
    const first = root.querySelector('#dlgBody input') || $((actions.find((a) => a.focus) || actions[0]).id)
    setTimeout(() => first.focus(), 30)
  }
  function toast(text, { kind = 'ok', action = null, sticky = false } = {}) {
    const t = document.createElement('div')
    t.className = `toast ${kind}${sticky ? ' sticky' : ''}`
    if (kind === 'warn') t.setAttribute('role', 'alert'); else t.setAttribute('role', 'status')
    t.innerHTML = `<span class="ic">${icon(kind === 'ok' ? 'okc' : kind === 'warn' ? 'warn' : 'info', 20)}</span><div class="txt">${esc(text)}${action ? `<button class="link act">${esc(action.label)}</button>` : ''}</div><button class="x" aria-label="Dismiss">${icon('close', 16)}</button>`
    const dismiss = () => { if (!t.isConnected || t.classList.contains('out')) return; t.classList.add('out'); t.addEventListener('animationend', () => t.remove()); setTimeout(() => t.remove(), 400) }
    t.dismiss = dismiss
    if (action) t.querySelector('.act').onclick = () => { action.run(); dismiss() }
    t.querySelector('.x').onclick = dismiss
    let timer = null
    const arm = () => { clearTimeout(timer); if (!sticky) timer = setTimeout(dismiss, action ? 8000 : 5000) }
    t.addEventListener('mouseenter', () => clearTimeout(timer)); t.addEventListener('focusin', () => clearTimeout(timer))
    t.addEventListener('mouseleave', arm); t.addEventListener('focusout', arm)
    $('toasts').appendChild(t)
    arm()
  }
  // ---- menus (Saved selections, Export): keyboard like Fluent menus
  function openMenu(btn, menu) {
    closeMenus()
    menu.hidden = false; btn.setAttribute('aria-expanded', 'true')
    const items = [...menu.querySelectorAll('[role^=menuitem]:not([hidden])')]
    if (items[0]) items[0].focus()
  }
  function closeMenus(focusBtn) {
    for (const [b, m] of [['savedBtn', 'savedMenu'], ['exportBtn', 'exportMenu'], ['moreBtn', 'moreMenu']]) if (!$(m).hidden) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); if (focusBtn) $(b).focus() }
  }
  for (const m of ['savedMenu', 'exportMenu', 'moreMenu']) $(m).addEventListener('keydown', (e) => {
    const items = [...$(m).querySelectorAll('[role^=menuitem]:not([hidden])')], i = items.indexOf(root.activeElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = items.length; if (n) items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus() }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); if (items.length) items[e.key === 'Home' ? 0 : items.length - 1].focus() }
    else if (e.key === 'Tab') { closeMenus(true); e.preventDefault() }
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('s-item')) { e.preventDefault(); e.target.click() }
  })
  root.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeMenus() })

  // ---- the choice screen
  function setView(v) {
    view = v
    $('vPick').hidden = v !== 'pick'
    $('vRes').hidden = v !== 'results'
    for (const t of root.querySelectorAll('.toast:not(.sticky)')) t.dismiss()
    closeMenus(); closePop(); closeSheet()
    if (v === 'pick') { keepDeleted.clear(); renderPick(); setTimeout(() => $('solSearch').focus(), 30) }
    else { renderResults(); setTimeout(() => $('resTitle').focus(), 30) }
  }
  function solRows() {
    const t = $('solSearch').value.trim().toLowerCase()
    return allSolutions.filter((s) => (showAll || !(MICROSOFT.test(s.publisher) || s.hidden) || chosen.has(s.unique)) && (!t || [s.name, s.unique, s.publisher].join(' ').toLowerCase().includes(t)))
  }
  function renderSolutions() {
    const list = $('solList')
    list.setAttribute('aria-busy', String(solState === 'loading'))
    for (const id of ['showAll', 'selAll', 'selNone']) $(id).disabled = solState !== 'ready'
    if (solState === 'loading') { list.innerHTML = Array.from({ length: 6 }, (_, i) => `<div class="sk" aria-hidden="true"><i style="width:16px;height:16px;border-radius:3px"></i><div style="flex:1;display:grid;gap:8px"><i style="height:12px;width:${36 + (i * 13) % 30}%"></i><i style="height:10px;width:${18 + (i * 7) % 14}%"></i></div><div style="display:grid;gap:8px;justify-items:end"><i style="height:10px;width:72px"></i><i style="height:10px;width:96px"></i></div></div>`).join(''); return }
    if (solState === 'failed') { list.innerHTML = `<div class="empty"><div class="ic bad">${icon('error', 24)}</div><b>Couldn't load the managed solutions</b><div style="max-width:420px">${esc(solError)}</div><div class="acts"><button class="btn primary" id="solRetry">${icon('refresh', 20)} Try again</button></div></div>`; $('solRetry').onclick = loadSolutions; return }
    if (solState === 'none') { list.innerHTML = `<div class="empty"><div class="ic">${icon('info', 22)}</div><b>No managed solutions</b><div>This environment has no managed solutions to check.</div></div>`; return }
    const rows = solRows()
    list.innerHTML = rows.length ? rows.map((s, i) => {
      const on = chosen.has(s.unique)
      return `<div class="row ${on ? 'on' : ''}" role="option" aria-selected="${on}" tabindex="${i === 0 ? 0 : -1}" data-u="${esc(s.unique)}"><input type="checkbox" tabindex="-1" aria-hidden="true" ${on ? 'checked' : ''}>
        <div class="main"><div class="nm">${esc(s.name)}${s.hidden ? '<span class="tag">Hidden</span>' : ''}</div><div class="un">${esc(s.unique)}</div></div>
        <div class="side"><div>${esc(s.publisher)}</div><div>${esc(s.version)}${s.installedOn ? ' · Installed ' + esc(s.installedOn) : ''}</div></div></div>`
    }).join('') : `<div class="empty"><div class="ic">${icon('search', 22)}</div><b>No solutions found</b><div>${showAll ? 'Try another search.' : 'Try another search, or show Microsoft and hidden solutions too.'}</div></div>`
    if (firstList && rows.length) { firstList = false; list.classList.add('enter'); setTimeout(() => list.classList.remove('enter'), 200) }
  }
  // With tables chosen, only the object types that can belong to a table are checked; the others are shown turned off.
  const TABLE_GROUPS = new Set(['Tables', 'Columns', 'Relationships', 'Keys', 'Forms', 'Views', 'Charts', 'Dashboards', 'Business rules', 'Other processes', 'Other'])
  const groupOn = (g) => !tablesSel.size || TABLE_GROUPS.has(g)
  function syncTypesHead() {
    const on = typesOn().length, all = shownGroups().length
    $('typesAll').checked = on === all
    $('typesAll').indeterminate = on > 0 && on < all
    $('typeCount').hidden = on === all || !on
    $('typeCount').textContent = `${on} selected`
  }
  function renderTypes() {
    syncTypesHead()
    $('typeList').innerHTML = (tablesSel.size ? `<div class="t-note">${icon('info')}<span>Only the types that belong to a table are listed, because tables are chosen below. Check all tables to see the others.</span></div>` : '')
      + TYPE_SECTIONS.map(([h, gs]) => { const list = gs.filter(groupOn); return list.length ? `<div class="t-sec"><h4>${esc(h)}</h4><div class="t-grid">${list.map((g) => `<label class="t-item"><input type="checkbox" data-g="${esc(g)}" ${typesSel.has(g) ? 'checked' : ''}>${esc(g)}</label>`).join('')}</div></div>` : '' }).join('')
  }
  function renderSaved() {
    const saved = loadSaved()
    $('savedMenu').innerHTML = saved.length ? saved.map((x) => {
      const desc = `${plural(x.solutions.length, 'solution')} · ${typesText(x.types || [])}${x.tables && x.tables.length ? ` · ${tablesText(x.tables)}` : ''}`
      return `<div class="s-item" role="menuitem" tabindex="-1" data-name="${esc(x.name)}"><span class="ck">${x.name === activeSaved ? icon('check', 16) : ''}</span><div class="tx"><div>${esc(x.name)}</div><small>${esc(desc)}</small></div><button class="btn subtle icon s-del" tabindex="-1" aria-label="Remove saved selection ${esc(x.name)}" title="Remove">${icon('trash', 16)}</button></div>`
    }).join('') : `<div class="m-empty">No saved selections yet. Choose solutions and types, then select Save selection.</div>`
  }
  function renderPickBar() {
    const n = picked().length, t = typesChosen(), anyType = typesOn().length > 0
    const ready = solState === 'ready' && n > 0 && anyType
    $('scanBtn').disabled = !ready || busy
    $('saveBtn').disabled = !ready
    $('solCount').hidden = !n
    $('solCount').textContent = `${n} selected`
    $('toResults').hidden = !result
    const m = $('pickMsg')
    m.className = 'msg' + (solState === 'failed' ? ' bad' : '')
    m.innerHTML = solState === 'loading' ? `<span class="spin" style="color:var(--brand)"></span><span>Loading managed solutions…</span>`
      : solState === 'failed' ? `${icon('error')}<span>The solution list couldn't be loaded.</span>`
      : !n ? `<span>${pickReason ? esc(pickReason) : 'Select at least one managed solution to scan.'}</span>`
      : !anyType ? '<span>Select at least one object type.</span>'
      : `<span>${activeSaved ? `<b>${esc(activeSaved)}</b> · ` : ''}<b>${plural(n, 'solution')}</b> · ${esc(typesText(t))}${tablesSel.size ? ` · ${esc(tablesText(tablesChosen()))}` : ''}${pickReason ? `<span class="quiet"> · ${esc(pickReason)}</span>` : ''}</span>`
  }
  function renderPick() { renderSaved(); renderSolutions(); renderTables(); renderTypes(); renderPickBar() }
  // ---- tables: all, or only the components of some tables (as Solution Layers Explorer's table selection)
  const readTables = async () => { for (let i = 0; ; i++) { try { return await getAll('EntityDefinitions?$select=LogicalName,DisplayName,IsPrivate') } catch (e) { if (!(e instanceof StopError) || i >= 20) throw e; await sleep(300) } } }
  const loadTables = () => tablesPromise || (tablesPromise = readTables().then((rows) => {
    tableList = rows.filter((t) => !t.IsPrivate).map((t) => ({ logical: lc(t.LogicalName), name: label(t.DisplayName) || t.LogicalName }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.logical.localeCompare(b.logical))
    if (view === 'pick') { renderTables(); renderPickBar(); renderSaved() }
    return tableList
  }, (e) => { tablesPromise = null; throw e }))
  function renderTables() {
    const t = tablesChosen(), n = t.length
    $('tblBtn').disabled = solState !== 'ready'
    $('tblBtn').innerHTML = n ? 'Change' : `${icon('table', 20)} Choose tables`
    $('tblCount').hidden = !n
    $('tblCount').textContent = `${n} selected`
    $('tblBody').innerHTML = n ? `<div class="tb-tags">${t.slice(0, 16).map((x) => `<span class="ttag" title="${esc(x)}">${esc(tableName(x))}</span>`).join('')}${n > 16 ? `<span class="more">+${n - 16} more</span>` : ''}</div>
      <div class="hint">Only these tables are checked: the tables themselves and their columns, relationships, keys, forms, dashboards, views, charts, business rules and processes (of the object types ticked above). <button class="link" id="tblAllBtn">Check all tables</button></div>`
      : '<div class="quiet">Every table is checked. Choose tables to check only their components: the object types that don\'t belong to a table (web resources, security roles, apps and others) are then left out.</div>'
    if ($('tblAllBtn')) $('tblAllBtn').onclick = () => { tablesSel = new Set(); changedPick(); renderTables(); renderTypes(); $('tblBtn').focus() }
  }
  $('tblBtn').onclick = () => {
    if (solState !== 'ready') return
    const tmp = new Set(tablesSel)
    openDialog({ title: 'Choose tables', wide: true,
      body: `<p>The scan checks only the tables you pick: each table itself and its columns, relationships, keys, forms, dashboards, views, charts, business rules and processes, of the object types you ticked. Components that belong to no table (web resources, security roles, apps and so on) are then skipped.</p>
        <div class="tl-tools"><label class="input">${icon('search')}<input type="search" id="tlQ" placeholder="Search tables" aria-label="Search tables" autocomplete="off"></label><label class="chk"><input type="checkbox" id="tlSel"> Selected only</label><button class="link" id="tlAll">Select all shown</button><button class="link" id="tlNone">Clear</button></div>
        <div class="tl-list" id="tlList" role="listbox" aria-multiselectable="true" aria-label="Tables"></div>
        <div class="tl-foot"><span id="tlCount"></span></div>`,
      actions: [{ id: 'dlgOk', label: 'Done', kind: 'primary' }, { id: 'dlgCancel', label: 'Cancel' }] })
    const shownTables = () => {
      const q = $('tlQ').value.trim().toLowerCase(), only = $('tlSel').checked
      return (tableList || []).filter((t) => (!only || tmp.has(t.logical)) && (!q || t.name.toLowerCase().includes(q) || t.logical.includes(q)))
    }
    const count = () => { $('tlCount').textContent = tmp.size ? `${plural(tmp.size, 'table')} selected` : 'None selected: all tables are checked' }
    const draw = () => {
      const list = $('tlList')
      if (!tableList) { list.innerHTML = `<div class="empty"><span class="spin" style="color:var(--brand)"></span><div>Loading tables…</div></div>`; return }
      const rows = shownTables()
      list.innerHTML = rows.length ? rows.map((t, i) => { const on = tmp.has(t.logical); return `<div class="tl-row${on ? ' on' : ''}" role="option" aria-selected="${on}" tabindex="${i ? -1 : 0}" data-t="${esc(t.logical)}"><input type="checkbox" tabindex="-1" aria-hidden="true" ${on ? 'checked' : ''}><div class="main"><div class="nm">${esc(t.name)}</div><div class="un">${esc(t.logical)}</div></div></div>` }).join('')
        : `<div class="empty"><div class="ic">${icon('search', 22)}</div><b>No tables found</b></div>`
      count()
    }
    const toggle = (row) => { const t = row.dataset.t, on = !tmp.has(t); on ? tmp.add(t) : tmp.delete(t); row.classList.toggle('on', on); row.setAttribute('aria-selected', String(on)); row.querySelector('input').checked = on; count() }
    $('tlQ').addEventListener('input', draw)
    $('tlSel').addEventListener('change', draw)
    $('tlList').addEventListener('click', (e) => { const r = e.target.closest('.tl-row'); if (r) toggle(r) })
    $('tlList').addEventListener('keydown', (e) => {
      const r = e.target.closest && e.target.closest('.tl-row')
      if (!r) return
      const rows = [...$('tlList').querySelectorAll('.tl-row')], i = rows.indexOf(r)
      const go = (j) => { const n = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (n) { r.tabIndex = -1; n.tabIndex = 0; n.focus() } }
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(r) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1) } else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1) }
      else if (e.key === 'Home') { e.preventDefault(); go(0) } else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1) }
    })
    $('tlAll').onclick = () => { for (const t of shownTables()) tmp.add(t.logical); draw() }
    $('tlNone').onclick = () => { tmp.clear(); draw() }
    $('dlgCancel').onclick = () => dlgClose()
    $('dlgOk').onclick = () => { tablesSel = new Set(tmp); dlgClose(); changedPick(); renderTables(); renderTypes() }
    draw()
    if (!tableList) loadTables().then(() => { if ($('tlList')) draw() }, (e) => { if ($('tlList')) $('tlList').innerHTML = `<div class="empty"><div class="ic bad">${icon('error', 24)}</div><b>Couldn't load the tables</b><div class="err-box">${esc(e.message)}</div></div>` })
  }
  const changedPick = () => { activeSaved = ''; pickReason = ''; renderPickBar() }
  function toggleSol(row) {
    const u = row.dataset.u, on = !chosen.has(u)
    on ? chosen.add(u) : chosen.delete(u)
    row.classList.toggle('on', on); row.setAttribute('aria-selected', String(on)); row.querySelector('input').checked = on
    changedPick()
  }
  $('solList').addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r) toggleSol(r) })
  $('solList').addEventListener('keydown', (e) => {
    const r = e.target.closest && e.target.closest('.row')
    if (!r) return
    const rows = [...$('solList').querySelectorAll('.row')], i = rows.indexOf(r)
    const go = (j) => { const n = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (n) { r.tabIndex = -1; n.tabIndex = 0; n.focus() } }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleSol(r) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1) } else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1) }
    else if (e.key === 'Home') { e.preventDefault(); go(0) } else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1) }
  })
  $('solSearch').addEventListener('input', renderSolutions)
  $('showAll').onclick = () => { showAll = !showAll; $('showAll').setAttribute('aria-checked', String(showAll)); renderSolutions() }
  $('selAll').onclick = () => { for (const s of solRows()) chosen.add(s.unique); changedPick(); renderSolutions() }
  $('selNone').onclick = () => { chosen.clear(); changedPick(); renderSolutions() }
  $('typesAll').addEventListener('change', () => {   // the types listed (with tables chosen, the others keep their ticks for later)
    for (const g of shownGroups()) $('typesAll').checked ? typesSel.add(g) : typesSel.delete(g)
    changedPick(); renderTypes()
  })
  $('typeList').addEventListener('change', (e) => {
    const g = e.target.dataset && e.target.dataset.g
    if (!g) return
    e.target.checked ? typesSel.add(g) : typesSel.delete(g)
    syncTypesHead()
    changedPick()
  })
  function applySaved(x) {
    const known = new Set(allSolutions.map((s) => s.unique)), missing = x.solutions.filter((u) => !known.has(u))
    chosen = new Set(x.solutions.filter((u) => known.has(u)))
    setTypes(x.pick && x.pick.length ? x.pick : x.types)
    setTables(x.tables)
    pickReason = ''
    renderPick()
    activeSaved = x.name
    renderSaved(); renderPickBar()
    if (missing.length) toast(`${plural(missing.length, 'solution')} in “${x.name}” ${missing.length === 1 ? "isn't" : "aren't"} installed here: ${missing.join(', ')}.`, { kind: 'warn' })
  }
  $('savedBtn').onclick = (e) => { e.stopPropagation(); if ($('savedMenu').hidden) { renderSaved(); openMenu($('savedBtn'), $('savedMenu')) } else closeMenus() }
  $('savedMenu').addEventListener('click', (e) => {
    const it = e.target.closest('.s-item')
    if (!it || busy) return
    const all = loadSaved(), x = all.find((y) => y.name === it.dataset.name)
    if (!x) { renderSaved(); return }
    if (e.target.closest('.s-del')) {
      e.stopPropagation()
      storeSaved(all.filter((y) => y.name !== x.name))
      if (activeSaved === x.name) { activeSaved = ''; renderPickBar() }
      renderSaved()
      const first = $('savedMenu').querySelector('[role=menuitem]'); if (first) first.focus(); else $('savedBtn').focus()
      toast(`Removed “${x.name}”.`, { action: { label: 'Undo', run: () => { const l = loadSaved().filter((y) => y.name !== x.name); l.push(x); l.sort((a, b) => a.name.localeCompare(b.name)); storeSaved(l); renderSaved() } } })
      return
    }
    closeMenus()
    applySaved(x)
    setTimeout(() => (!$('scanBtn').disabled ? $('scanBtn') : $('solSearch')).focus(), 0)
  })
  $('saveBtn').onclick = () => {
    const existing = loadSaved()
    const summary = `${plural(picked().length, 'solution')} · ${typesText(typesChosen())}${tablesSel.size ? ` · ${tablesText(tablesChosen())}` : ''}.`
    openDialog({ title: 'Save selection', body: `<div class="field"><label for="saveName">Name</label><div class="input"><input id="saveName" maxlength="60" value="${esc(activeSaved)}" placeholder="For example: Sales forms and views" autocomplete="off"></div>
      <div class="hint">${esc(summary)} Saved in this browser ${ON_MAKER ? 'for every environment' : 'for this environment only'}. Find it under Saved selections.</div><div class="hint" id="saveDup" hidden>A saved selection with this name already exists. Saving replaces it.</div></div>`,
      actions: [{ id: 'dlgOk', label: 'Save', kind: 'primary' }, { id: 'dlgCancel', label: 'Cancel' }] })
    const name = () => $('saveName').value.trim()
    const sync = () => { const dup = existing.some((x) => x.name === name()); $('dlgOk').disabled = !name(); $('dlgOk').textContent = dup ? 'Replace' : 'Save'; $('saveDup').hidden = !dup }
    $('saveName').addEventListener('input', sync)
    $('saveName').addEventListener('keydown', (e) => { if (e.key === 'Enter' && name()) $('dlgOk').click() })
    sync()
    $('dlgCancel').onclick = () => dlgClose()
    $('dlgOk').onclick = () => {
      const n = name()
      if (!n) return
      // Solutions of the saved selection that are not installed in this environment are kept in it.
      const old = loadSaved().find((x) => x.name === n), known = new Set(allSolutions.map((s) => s.unique))
      const keep = old ? old.solutions.filter((u) => !known.has(u)) : []
      const list = loadSaved().filter((x) => x.name !== n)
      list.push({ name: n, solutions: [...new Set([...picked().map((s) => s.unique), ...keep])], types: typesChosen(), pick: [...typesSel], tables: tablesChosen(), savedOn: new Date().toISOString().slice(0, 10) })
      list.sort((a, b) => a.name.localeCompare(b.name))
      const ok = storeSaved(list)
      dlgClose()
      if (ok) { activeSaved = n; renderSaved(); renderPickBar(); toast(`Saved “${n}”. Find it under Saved selections.`) } else toast("This browser didn't allow saving it.", { kind: 'warn' })
    }
  }
  $('scanBtn').onclick = () => runScan(picked(), typesChosen(), tablesChosen())
  $('toResults').onclick = () => { if (result) setView('results') }

  // ---- scanning
  const scopeText = (sols, types, tables) => `${sols.length === 1 ? sols[0].name : plural(sols.length, 'managed solution')} · ${typesText(types)}${tables && tables.length ? ` · ${tablesText(tables)}` : ''}`
  let scanScope = '', scanTypes = [], scanGen = 0
  const progOff = (off) => { $('prog').classList.toggle('off', off); if (off) $('prog').setAttribute('aria-hidden', 'true'); else $('prog').removeAttribute('aria-hidden') }
  const progress = (msg, pct) => {
    if (!scanning || stopReads) return
    const v = Math.max(2, Math.min(100, pct))
    $('stepTxt').textContent = msg
    $('stepPct').textContent = `${Math.round(v)}%`
    $('pg').style.width = v + '%'
    $('prog').setAttribute('aria-valuenow', String(Math.round(v)))
  }
  async function withBusy(fn) {
    if (busy) return false
    busy = true
    try { await fn(); return true } finally { busy = false }
  }
  function runScan(sols, types, tables = []) {
    if (!sols.length || busy) return
    try { localStorage.setItem(STORE, JSON.stringify({ solutions: sols.map((x) => x.unique), types, tables, pick: [...typesSel] })) } catch { }
    selected.clear(); status.clear(); keepDeleted.clear(); layerCache.clear(); result = null; filters = {}; sortBy = null; pinned = new Set(); scanError = ''; $('q').value = ''
    closeSheet(); closePop()
    scanning = true; resumeReads(); scanGen++; scanScope = scopeText(sols, types, tables); scanTypes = types
    $('stepTxt').textContent = 'Starting…'; $('stepPct').textContent = ''
    const pg = $('pg'); pg.style.transition = 'none'; pg.style.width = '2%'; void pg.offsetWidth; pg.style.transition = ''
    setView('results')
    let stopped = false
    withBusy(async () => {
      try { result = await scan(sols, progress, { allSolutions, objectTypes: types, tables }) }
      catch (e) { if (e instanceof StopError) stopped = true; else scanError = e.message; result = null }
      finally {
        scanning = false
        const gen = scanGen
        const settle = () => { if (gen !== scanGen) return; if (!liveRequests) resumeReads(); else setTimeout(settle, 100) }   // the scan's other reads end first
        setTimeout(settle, 0)
        $('stopScan').hidden = true
        if (stopped) { progOff(true); setView('pick'); toast('Scan stopped.', { kind: 'info' }); return }
        if (result) { pg.style.width = '100%'; finishing = true; setTimeout(() => { finishing = false; if (!scanning) progOff(true) }, 300) }
        renderResults()
        announce(result ? `Scan finished: ${result.findings.length ? plural(result.findings.length, 'unmanaged layer') : 'no unmanaged layers'}.` : "Scan didn't finish.")
      }
    }).then(() => { if (stopped && view === 'pick') renderPickBar() })
  }

  // ---- results
  const active = () => (result ? result.findings.filter((f) => !f.deleted) : [])
  // Types whose unmanaged layer Dataverse does not delete (error 0x8004f059): e-mail templates, and any type that
  // fails that way during this session. They stay in the list and the exports, without a tick box.
  const undeletable = new Set([36])
  const cannotDelete = (f) => undeletable.has(f.code)
  const NO_DELETE = 'Dataverse does not allow deleting the unmanaged layer of this type. Undo the change by hand, or import the managed solution again with "Overwrite unmanaged customizations".'
  const selectable = (f) => !IS_DEV && !deleting && !f.deleted && !cannotDelete(f)
  const SPECIAL_TIPS = { 'Only system values': 'Only values Dataverse sets itself changed, such as Modified on', 'Only status or owner': 'Only the status (on or off) or the owner changed' }
  const solName = (id) => (allSolutions.find((s) => s.id === id) || {}).name || ''
  const solNameU = (u) => (allSolutions.find((s) => s.unique === u) || {}).name || u
  const cmpText = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })

  // ---- column filters and sorting, as in Excel or Dynamics: each column's menu sorts the rows and lists the column's
  // values with how many rows have each; ticking or clearing a value filters at once. "What changed" has one value per
  // property, so a row is shown when any of its changed properties is ticked.
  const changedValues = (f) => (!f.detailsLoaded && !f.changed ? ['Not read yet'] : f.changedKeys ? f.changedKeys : [f.changed || '(None)'])
  const COLS = {
    type: ['Type', (f) => [f.type]],
    name: ['Name', (f) => [f.display || f.schema || '(no name)']],
    table: ['Table', (f) => [f.table ? f.tableLabel || f.table : '(No table)']],
    solution: ['Managed solution', (f) => (f.solutionIds && f.solutionIds.length ? f.solutionIds.map((id) => solName(id) || id) : [f.solutions || '(None)'])],
    changed: ['What changed', changedValues],
  }
  let filters = {}, sortBy = null   // filters: column -> Set of the values shown; sortBy: { col, dir }
  const pop = { col: '', el: null, vals: [], vis: [] }
  const passes = (f, skip) => { for (const c in filters) if (c !== skip && !COLS[c][1](f).some((v) => filters[c].has(v))) return false; return true }
  const query = () => $('q').value.trim().toLowerCase()
  const matches = (f, q) => !q || [f.type, f.display, f.schema, f.tableLabel, f.solutions, f.changed, ...(f.changedKeys || [])].join(' ').toLowerCase().includes(q)
  const visible = (f) => !f.deleted || keepDeleted.has(f.key)
  function shown() {
    if (!result) return []
    const q = query(), rows = result.findings.filter((f) => visible(f) && passes(f) && matches(f, q))
    if (sortBy) {
      const get = COLS[sortBy.col][1]
      rows.sort((a, b) => sortBy.dir * cmpText(get(a).join(', '), get(b).join(', ')) || cmpText(a.type, b.type) || cmpText(a.display || a.schema, b.display || b.schema))
    }
    return rows
  }
  const drawnRows = () => shown().slice(0, CONFIG.maxRows)
  // A column's values, with how many rows have each, among the rows that the other filters and the search leave.
  function columnValues(col) {
    const q = query(), counts = new Map()
    for (const f of result.findings) if (visible(f) && passes(f, col) && matches(f, q)) for (const v of new Set(COLS[col][1](f))) counts.set(v, (counts.get(v) || 0) + 1)
    if (filters[col]) for (const v of filters[col]) if (!counts.has(v)) counts.set(v, 0)
    return [...counts].sort((a, b) => (a[0][0] === '(') - (b[0][0] === '(') || cmpText(a[0], b[0]))
  }
  function renderFilters() {
    // the column filters other than Type (the type bubbles show that one): their own way to clear them all
    const others = Object.keys(filters).filter((c) => c !== 'type')
    $('fClear').hidden = !others.length
    $('fClear').disabled = !!deleting
    $('fClear').textContent = `Clear filters (${others.length})`
    renderChips()   // after Clear filters: its width counts
    for (const b of root.querySelectorAll('#grid thead .hb')) {
      const c = b.dataset.col, dir = sortBy && sortBy.col === c ? sortBy.dir : 0
      b.querySelector('.ind').innerHTML = (dir ? `<span class="on">${icon(dir > 0 ? 'sortUp' : 'sortDown', 14)}</span>` : '') + (filters[c] ? `<span class="on">${icon('filter', 14)}</span>` : '') + icon('chevron', 12)
      b.disabled = !!deleting || scanning
      b.closest('th').setAttribute('aria-sort', dir > 0 ? 'ascending' : dir < 0 ? 'descending' : 'none')
    }
    if (pop.col && pop.el) { pop.el.setAttribute('aria-expanded', 'true'); placePop() }
  }
  // ---- type bubbles: a click shows only that type (again: all types); Ctrl+click adds or removes a type. They are the
  // Type column's filter. Bubbles that don't fit on the row are listed under More, so the row never runs off the window.
  function renderChips() {
    const counts = new Map()
    for (const f of active()) counts.set(f.type, (counts.get(f.type) || 0) + 1)
    const ft = filters.type, on = (t) => !!(ft && ft.has(t))
    if (ft) for (const t of ft) if (!counts.has(t)) counts.set(t, 0)   // a chosen type whose rows were all deleted stays pressed, with 0
    // a fixed order (most rows first); types picked from More stay right after All: a click never moves the bubbles
    const types = [...counts].sort((a, b) => (pinned.has(b[0]) - pinned.has(a[0])) || (pinned.has(a[0]) ? [...pinned].indexOf(a[0]) - [...pinned].indexOf(b[0]) : 0) || b[1] - a[1] || cmpText(a[0], b[0]))
    $('chips').innerHTML = types.length > 1 || ft ? `<button class="chip" data-type="" aria-pressed="${!ft}" title="All types">All <span class="n">${active().length.toLocaleString()}</span></button>`
      + types.map(([k, n]) => `<button class="chip" data-type="${esc(k)}" aria-pressed="${on(k)}" title="${esc(`Show only ${k}. Ctrl+click to add it to the types shown.`)}">${esc(k)} <span class="n">${n.toLocaleString()}</span></button>`).join('') : ''
    for (const c of root.querySelectorAll('#chips .chip')) c.disabled = !!deleting
    chipsKey = ''
    layoutChips()
  }
  let chipsKey = '', pinned = new Set()   // pinned: types picked from More (cleared by a new scan)
  function layoutChips() {
    const box = $('chips'), tools = $('resTools')
    if (!tools.clientWidth) return   // not on screen: laid out when it is (the size watcher)
    const key = `${tools.clientWidth}|${box.childElementCount}|${$('fClear').hidden}`
    if (key === chipsKey) return
    const hadFocus = !$('moreMenu').hidden && $('moreMenu').contains(root.activeElement)   // only when it closes here
    if (!$('moreMenu').hidden) { $('moreMenu').hidden = true; $('moreBtn').setAttribute('aria-expanded', 'false') }   // its items are built again
    if (hadFocus) setTimeout(() => (!$('moreWrap').hidden ? $('moreBtn') : $('q')).focus(), 0)
    let chips = [...box.querySelectorAll('.chip')]
    for (const c of chips) c.hidden = false
    $('moreWrap').hidden = true
    const over = () => { const right = box.getBoundingClientRect().right + 0.5; return chips.filter((c) => c.getBoundingClientRect().right > right) }
    const label = (n) => { $('moreBtn').innerHTML = `More <span class="n">${n}</span>${icon('chevron', 12)}`; $('moreBtn').setAttribute('aria-label', `${n} more types`) }
    const settle = () => { let h = over(); for (let i = 0; i < 4; i++) { label(h.length); const h2 = over(); if (h2.length === h.length) return h2; h = h2 } return over() }
    let hide = over()
    const ft = filters.type
    if (hide.length) {
      $('moreWrap').hidden = false   // More takes some of the room
      hide = settle()
    }
    for (const c of hide) c.hidden = true
    $('moreBtn').classList.toggle('on', hide.some((c) => ft && ft.has(c.dataset.type)))
    $('moreBtn').disabled = !!deleting
    label(hide.length)
    $('moreMenu').innerHTML = hide.map((c) => `<button class="mi" role="menuitemcheckbox" tabindex="-1" data-type="${esc(c.dataset.type)}" aria-checked="${c.getAttribute('aria-pressed')}"><span>${c.getAttribute('aria-pressed') === 'true' ? '✓ ' : ''}${esc(c.dataset.type)}</span><small>${esc(c.querySelector('.n').textContent)}</small></button>`).join('')
    $('moreWrap').hidden = !hide.length
    chipsKey = `${tools.clientWidth}|${box.childElementCount}|${$('fClear').hidden}`
  }
  new ResizeObserver(() => layoutChips()).observe($('resTools'))   // the row's width (the bubbles' own box shrinks to them)
  const typeClick = (t, add) => {
    if (deleting || !result) return
    const ft = filters.type
    if (!t) setFilter('type', null)
    else if (add) { const s = new Set(ft || []); s.has(t) ? s.delete(t) : s.add(t); setFilter('type', s.size ? s : null) }
    else setFilter('type', ft && ft.size === 1 && ft.has(t) ? null : new Set([t]))
  }
  const focusChip = (t) => { const c = [...root.querySelectorAll('#chips .chip:not([hidden])')].find((x) => x.dataset.type === t); (c || (!$('moreWrap').hidden && $('moreBtn')) || $('q')).focus() }
  $('chips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) { const t = c.dataset.type; typeClick(t, e.ctrlKey || e.metaKey); focusChip(t) } })
  $('moreBtn').onclick = (e) => { e.stopPropagation(); if ($('moreMenu').hidden) openMenu($('moreBtn'), $('moreMenu')); else closeMenus() }
  // ---- column widths: drag a column's right edge; double-click it, or "Fit to contents" in the column's menu, to make
  // it as wide as its longest value shown; "Reset column widths" there puts them back. Remembered in this browser.
  // What changed has no edge of its own: it takes the room the others leave (at least 150 px; the grid scrolls sideways
  // below that).
  const COLW = 'unmanagedLayerScanner:columns', COL_KEYS = ['type', 'name', 'table', 'solution']
  const COL_MIN = { type: 90, name: 120, table: 100, solution: 100 }, COL_MAX = 900, CHANGED_MIN = 150
  const colEls = [...root.querySelectorAll('#grid colgroup col')], COL_DEFAULT = colEls.map((c) => c.style.width)   // tick, the four, What changed, actions
  let colW = null
  try { const v = JSON.parse(localStorage.getItem(COLW) || 'null'); if (v && COL_KEYS.every((k) => Number.isFinite(v[k]) && v[k] >= 40 && v[k] <= 3000)) colW = Object.fromEntries(COL_KEYS.map((k) => [k, Math.round(v[k])])) } catch { }
  // hold: while dragging, the grid keeps at least the width it had (so a scrolled grid does not slide under the pointer)
  function applyColWidths(hold = 0) {
    const grid = $('grid')
    if (!colW) { colEls.forEach((c, i) => { c.style.width = COL_DEFAULT[i] }); grid.style.minWidth = ''; return }
    COL_KEYS.forEach((k, i) => { colEls[i + 1].style.width = `${colW[k]}px` })
    colEls[5].style.width = ''   // What changed: the rest
    grid.style.minWidth = `${Math.max(48 + 88 + COL_KEYS.reduce((n, k) => n + colW[k], 0) + CHANGED_MIN, hold)}px`
  }
  const thOf = (k) => root.querySelector(`#grid thead .hb[data-col="${k}"]`).closest('th')
  const saveColW = () => { try { colW ? localStorage.setItem(COLW, JSON.stringify(colW)) : localStorage.removeItem(COLW) } catch { } }
  const startColW = () => { if (!colW) colW = Object.fromEntries(COL_KEYS.map((k) => [k, Math.floor(thOf(k).getBoundingClientRect().width)])) }   // from here on in pixels
  applyColWidths()
  let lastWrapW = 0
  new ResizeObserver(() => { const w = $('gridWrap').clientWidth; if (w === lastWrapW) return; lastWrapW = w; fitTags() }).observe($('gridWrap'))   // width changes only; before the frame is drawn
  let colDrag = null
  const thead = root.querySelector('#grid thead')
  thead.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.cr')
    if (!h || e.button !== 0 || colDrag) return
    e.preventDefault(); e.stopPropagation()
    colDrag = { k: h.dataset.c, x: e.clientX, w: Math.floor(thOf(h.dataset.c).getBoundingClientRect().width), id: e.pointerId, h, moved: false, hold: $('grid').offsetWidth }
    try { h.setPointerCapture(e.pointerId) } catch { }
    h.classList.add('on'); app.classList.add('colsizing'); closePop()
  })
  thead.addEventListener('pointermove', (e) => {
    if (!colDrag || e.pointerId !== colDrag.id) return
    const dx = e.clientX - colDrag.x
    if (!colDrag.moved) { if (Math.abs(dx) < 3) return; colDrag.moved = true; startColW() }   // a click is not a resize
    colW[colDrag.k] = Math.round(Math.min(COL_MAX, Math.max(COL_MIN[colDrag.k], colDrag.w + dx)))
    applyColWidths($('gridWrap').scrollLeft > 0 ? colDrag.hold : 0); scheduleFit()
  })
  const endColDrag = (e) => {
    if (!colDrag || (e && e.pointerId !== colDrag.id)) return
    const moved = colDrag.moved
    colDrag.h.classList.remove('on'); app.classList.remove('colsizing')
    colDrag = null
    if (moved) { applyColWidths(); saveColW(); fitTags() }
  }
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) thead.addEventListener(ev, endColDrag)
  // As wide as its longest value shown (and its header): the text's own width, whatever the column's width is now.
  const textW = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width }
  function fitColumn(k) {
    const i = COL_KEYS.indexOf(k) + 1, th = thOf(k), hb = th.querySelector('.hb')
    if (i < 1) return
    startColW()
    let w = textW(hb.querySelector('.l')) + hb.querySelector('.ind').getBoundingClientRect().width + 4 + 16 + 8 + 10   // gap, the button's and the cell's padding, the edge
    for (const tr of root.querySelectorAll('#rows tr[data-k]')) {
      const td = tr.children[i]
      if (!td) continue
      const parts = [...td.children]
      w = Math.max(w, 24 + (parts.length ? Math.max(...parts.map(textW)) : textW(td)))
    }
    colW[k] = Math.round(Math.min(COL_MAX, Math.max(COL_MIN[k], Math.ceil(w) + 2)))
    applyColWidths(); saveColW(); fitTags()
  }
  thead.addEventListener('dblclick', (e) => { const h = e.target.closest('.cr'); if (!h) return; e.preventDefault(); e.stopPropagation(); fitColumn(h.dataset.c) })
  $('popReset').onclick = () => { colW = null; saveColW(); applyColWidths(); fitTags(); closePop(true) }
  $('popFit').onclick = () => { const k = pop.col; closePop(true); fitColumn(k) }
  $('moreMenu').addEventListener('click', (e) => { const m = e.target.closest('[data-type]'); if (m) { const t = m.dataset.type; closeMenus(); pinned.add(t); typeClick(t, e.ctrlKey || e.metaKey); focusChip(t) } })
  function openPop(col, el) {
    if (!result || deleting || scanning || !COLS[col]) return
    if (pop.col === col && pop.el === el) { closePop(true); return }
    closePop(); closeMenus()
    pop.col = col; pop.el = el
    const what = COLS[col][0].toLowerCase()
    $('pop').setAttribute('aria-label', `Sort and filter ${what}`)
    $('popQ').value = ''
    $('popQ').placeholder = `Search ${what}`
    $('popQ').setAttribute('aria-label', `Search ${what}`)
    renderPop()
    $('pop').hidden = false
    el.setAttribute('aria-expanded', 'true')
    placePop()
    setTimeout(() => $('popQ').focus(), 0)
  }
  // Under its button (or above it when there is more room there), inside the window.
  function placePop() {
    const p = $('pop')
    if (p.hidden || !pop.el) return
    const pr = root.querySelector('.panel').getBoundingClientRect(), a = pop.el.getBoundingClientRect()
    const below = pr.bottom - a.bottom - 12, above = a.top - pr.top - 12, up = below < 300 && above > below
    p.style.left = Math.max(8, Math.min(a.left - pr.left, pr.width - p.offsetWidth - 8)) + 'px'
    p.style.maxHeight = Math.max(160, Math.min(520, up ? above : below)) + 'px'
    if (up) { p.style.top = 'auto'; p.style.bottom = (pr.bottom - a.top + 4) + 'px' } else { p.style.bottom = 'auto'; p.style.top = (a.bottom - pr.top + 4) + 'px' }
  }
  function closePop(focus) {
    if ($('pop').hidden) return
    $('pop').hidden = true
    const el = pop.el
    pop.col = ''; pop.el = null
    if (el) { el.setAttribute('aria-expanded', 'false'); if (focus && el.isConnected) el.focus() }
  }
  const POP_MAX = 300   // values listed at once; a search finds the others
  function renderPop() {
    $('popReset').hidden = !colW
    $('popFit').hidden = !COL_KEYS.includes(pop.col)
    const col = pop.col, q = $('popQ').value.trim().toLowerCase(), f = filters[col]
    pop.vals = columnValues(col)
    pop.vis = pop.vals.filter(([v]) => !q || v.toLowerCase().includes(q))
    for (const b of root.querySelectorAll('#pop [data-sort]')) b.querySelector('.ck').innerHTML = sortBy && sortBy.col === col && sortBy.dir === Number(b.dataset.sort) ? icon('check', 16) : ''
    $('popList').innerHTML = (pop.vis.length ? `<label class="pv all"><input type="checkbox" id="popAll"><span class="v">${q ? 'Select all search results' : 'Select all'}</span></label>` : '<div class="pop-more">No values match the search.</div>')
      + pop.vis.slice(0, POP_MAX).map(([v, n], i) => `<label class="pv"><input type="checkbox" data-i="${i}" ${!f || f.has(v) ? 'checked' : ''}><span class="v" title="${esc(v)}">${esc(v)}</span><span class="n">${n.toLocaleString()}</span></label>`).join('')
      + (pop.vis.length > POP_MAX ? `<div class="pop-more">${(pop.vis.length - POP_MAX).toLocaleString()} more values. Search to find them.</div>` : '')
    syncPopAll()
  }
  function syncPopAll() {
    const a = $('popAll'), f = filters[pop.col]
    $('popClear').disabled = !f
    if (!a) return
    const n = pop.vis.filter(([v]) => !f || f.has(v)).length
    a.checked = n === pop.vis.length; a.indeterminate = n > 0 && n < pop.vis.length
  }
  // Sets a column's filter (null: none). A filter that keeps every value is no filter.
  function setFilter(col, set) {
    if (set && [...allValues(col)].every((v) => set.has(v))) set = null
    if (set) filters[col] = set; else delete filters[col]
    keepDeleted.clear()
    renderFilters(); renderRows(); $('st').textContent = subtitle()
  }
  const clearFilters = () => { filters = {}; keepDeleted.clear(); closePop(); renderFilters(); renderRows(); $('st').textContent = subtitle() }
  // Every value of a column among the rows shown without any filter or search (a filter is kept against these).
  const allValues = (col) => { const out = new Set(); for (const f of result.findings) if (visible(f)) for (const v of COLS[col][1](f)) out.add(v); if (filters[col]) for (const v of filters[col]) out.add(v); return out }
  const currentSet = (col) => new Set(filters[col] || allValues(col))
  $('popList').addEventListener('change', (e) => {
    const col = pop.col, t = e.target
    if (!col) return
    if (t.id === 'popAll') {
      const s = currentSet(col)
      for (const [v] of pop.vis) t.checked ? s.add(v) : s.delete(v)
      setFilter(col, s)
      for (const c of root.querySelectorAll('#popList input[data-i]')) c.checked = t.checked
    } else if (t.dataset.i != null && pop.vis[Number(t.dataset.i)]) {
      const v = pop.vis[Number(t.dataset.i)][0], s = currentSet(col)
      t.checked ? s.add(v) : s.delete(v)
      setFilter(col, s)
    }
    syncPopAll()
  })
  $('popQ').addEventListener('input', renderPop)
  $('popQ').addEventListener('keydown', (e) => {   // Enter: only the values found, as in Excel
    if (e.key !== 'Enter' || !pop.col) return
    e.preventDefault()
    const f = filters[pop.col], keep = pop.vis.filter(([v]) => !f || f.has(v)).map(([v]) => v)
    if ($('popQ').value.trim() && keep.length) { setFilter(pop.col, new Set(keep)); closePop(true) }
  })
  for (const b of root.querySelectorAll('#pop [data-sort]')) b.onclick = () => {
    const dir = Number(b.dataset.sort)
    sortBy = sortBy && sortBy.col === pop.col && sortBy.dir === dir ? null : { col: pop.col, dir }   // the same again: back to the scan's order
    renderFilters(); renderRows()
    closePop(true)
  }
  $('popClear').onclick = () => { if (pop.col) { setFilter(pop.col, null); renderPop() } }
  $('popDone').onclick = () => closePop(true)
  $('pop').addEventListener('focusout', (e) => { const to = e.relatedTarget; if (to && !$('pop').contains(to) && to !== pop.el) closePop() })
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.hb[data-col]')
    if (b) { openPop(b.dataset.col, b); return }
    if (e.target.id === 'emptyClear') { clearFilters(); $('q').focus(); return }
    if (e.target.id === 'fClear') { for (const c of Object.keys(filters)) if (c !== 'type') delete filters[c]; keepDeleted.clear(); closePop(); renderFilters(); renderRows(); $('st').textContent = subtitle(); $('q').focus(); return }   // the type bubbles keep theirs
    if (!e.target.closest('#pop')) closePop()
  })

  function changedCell(f) {
    const keys = f.changedKeys
    let inner, tip
    if (!f.detailsLoaded && !f.changed) { inner = '<span class="quiet">Not read yet</span>'; tip = 'Not read yet' }
    else if (!keys) { inner = `<span class="quiet">${esc(f.changed || '')}</span>`; tip = SPECIAL_TIPS[f.changed] || f.changed || '' }
    else { inner = `<div class="tags" data-n="${keys.length}">${keys.slice(0, 40).map((k) => `<span class="ptag">${esc(k)}</span>`).join('')}<span class="more" hidden></span></div>`; tip = `Changed: ${keys.join(', ')}` }
    return `<button class="chg" data-view="${esc(f.key)}" ${deleting ? 'disabled' : ''} title="${esc(`${tip}. Select to see the layers and compare them.`)}">${inner}</button>`
  }
  const STATUS = { Skipped: ['', 'Skipped'], 'Not attempted': ['', 'Not tried'], Unknown: ['amb', 'Result unknown'], Failed: ['bad', 'Not deleted'], 'Deleted, not verified': ['amb', 'Deleted (not checked)'], 'Partly deleted': ['amb', 'Partly deleted'] }
  const sentenceCase = (s) => { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : '' }
  function statusCell(s) {
    const [cls, text] = STATUS[s.state] || ['', s.state]
    return `<div class="stat"><span class="pill ${cls}">${esc(text)}</span>${s.detail && s.detail !== 'you stopped the run' ? `<span class="why" title="${esc(sentenceCase(s.detail))}">${esc(sentenceCase(s.detail))}</span>` : ''}</div>`
  }
  function linkTitle(f, link) {
    if (/componentlayers/.test(link)) return f.code === 10 ? "Open the classic Solution layers page (it shows the relationship's cascade settings)" : 'Open the classic Solution layers page'
    return `Open solution layers in ${f.placedByLayers || !f.linkSolution ? 'Default Solution' : solName(f.linkSolution)}${f.code === 10 ? " (the maker portal shows the relationship's definition, not its cascade settings)" : ''}`
  }
  function rowHtml(f, sel) {
    const link = layersUrl(f), s = status.get(f.key), name = f.display || f.schema || '(no name)'
    const tick = f.deleted ? `<span class="donec" role="img" aria-label="Deleted">${icon('check', 16)}</span>`
      : s && s.state === 'Deleting' ? `<span class="spin" style="color:var(--brand)" role="img" aria-label="Deleting"></span>`
      : cannotDelete(f) && !IS_DEV ? `<span class="nodel" role="img" aria-label="Can't be deleted here" title="${esc(NO_DELETE)}">${icon('info', 16)}</span>`
      : `<input type="checkbox" data-k="${esc(f.key)}" ${sel || (deleting && deleting.keys.has(f.key) && !s) ? 'checked' : ''} ${selectable(f) ? '' : 'disabled'} aria-label="Select ${esc(name)}">`
    const tl = f.table ? /^(.*) \(([^()]+)\)$/.exec(f.tableLabel || '') : null
    const what = s && s.state !== 'Deleting' && !f.deleted ? statusCell(s) : changedCell(f)
    return `<tr class="${sel ? 'sel' : ''}${f.deleted ? ' done' : ''}${deleting && deleting.keys.has(f.key) && !f.deleted ? ' busy' : ''}" data-k="${esc(f.key)}" ${link ? `data-link="${esc(link)}"` : ''}>
      <td class="c">${tick}</td><td class="one ty" title="${esc(f.type)}">${esc(f.type)}</td>
      <td>${link ? `<a class="nm" href="${esc(link)}" target="_blank" rel="noopener" title="${esc(linkTitle(f, link))}">${esc(name)}</a>` : `<span class="nm">${esc(name)}</span>`}${f.display && f.schema ? `<div class="sc">${esc(f.schema)}</div>` : ''}</td>
      <td>${tl ? `<div class="one">${esc(tl[1])}</div><div class="lg">${esc(tl[2])}</div>` : f.table ? `<div class="one">${esc(f.tableLabel || f.table)}</div>` : '<span class="quiet">—</span>'}</td>
      <td class="one" title="${esc(f.solutions + (f.layers ? `\nManaged layers underneath, top first: ${f.layers}` : ''))}">${esc(f.solutions)}</td>
      <td>${what}</td>
      <td class="o"><button class="open vb" data-view="${esc(f.key)}" ${deleting ? 'disabled' : ''} title="Layers and what changed" aria-label="Layers and what changed: ${esc(name)}">${icon('diff')}</button>${link ? `<a class="open" href="${esc(link)}" target="_blank" rel="noopener" title="${esc(linkTitle(f, link))}" aria-label="${esc(linkTitle(f, link))}, ${esc(name)} (opens in a new tab)">${icon('open')}</a>` : ''}</td></tr>`
  }
  function renderRows() {
    const drawn = drawnRows()
    $('rows').innerHTML = drawn.map((f) => rowHtml(f, selected.has(f.key))).join('')
    const empty = $('empty'), any = active().length
    empty.hidden = !!drawn.length
    if (!drawn.length) empty.innerHTML = any ? `<div class="ic">${icon('search', 22)}</div><b>No components match</b><div>Try another search, or change the filters.</div>${Object.keys(filters).length ? '<div class="acts"><button class="btn" id="emptyClear">Clear filters</button></div>' : ''}`
      : (result.deleted || result.findings.some((f) => f.deleted)) ? `<div class="ic ok">${icon('check', 24)}</div><b>All unmanaged layers deleted</b><div>Every component in this list is back to its managed version.</div><div class="acts"><button class="btn" id="emptyBack">${icon('back', 20)} Change selection</button></div>`
      : `<div class="ic ok">${icon('check', 24)}</div><b>Nothing to clean up</b><div>No components ${result.types || result.tables ? 'of the selected types and tables ' : ''}in ${esc(result.solutions.length === 1 ? solNameU(result.solutions[0]) : `the ${result.solutions.length} selected solutions`)} have unmanaged customizations.</div><div class="acts"><button class="btn" id="emptyBack">${icon('back', 20)} Change selection</button></div>`
    if ($('emptyBack')) $('emptyBack').onclick = () => setView('pick')
    fitTags()
    syncSelection()
  }
  // What changed: as many property names as fit in the column, then +N for the others. All widths are read first,
  // then everything is written, so a long list costs one layout.
  function fitTags(scope) {
    if (!$('gridWrap').clientWidth) return   // not on screen: fitted when it is (the size watcher)
    const boxes = [...(scope || $('rows')).querySelectorAll('.tags[data-n]')]
    for (const b of boxes) { b.classList.add('measure'); for (const t of b.children) t.hidden = false; b.lastElementChild.textContent = `+${b.dataset.n}` }   // full widths, +N at its widest
    const m = boxes.map((b) => ({ b, room: b.parentElement.getBoundingClientRect().width - 12, tags: [...b.querySelectorAll('.ptag')].map((t) => t.getBoundingClientRect().width), more: b.lastElementChild.getBoundingClientRect().width }))
    for (const { b, room, tags, more } of m) {
      b.classList.remove('measure')
      const n = Number(b.dataset.n)
      let used = 0, k = 0
      for (let i = 0; i < tags.length; i++) {
        const next = used + (i ? 4 : 0) + tags[i], rest = n - i - 1
        if (next + (rest ? 4 + more : 0) > room + 0.01) break
        used = next; k = i + 1
      }
      k = Math.max(1, k)   // the first one at least, shortened with an ellipsis if need be
      const ts = b.querySelectorAll('.ptag')
      for (let i = 0; i < ts.length; i++) ts[i].hidden = i >= k
      const left = n - k, last = b.lastElementChild
      last.hidden = !left
      last.textContent = left ? `+${left}` : ''
    }
  }
  let fitPending = false
  const scheduleFit = () => { if (fitPending) return; fitPending = true; requestAnimationFrame(() => { fitPending = false; fitTags() }) }
  function updateRow(f) {
    const tr = root.querySelector(`#rows tr[data-k="${CSS.escape(f.key)}"]`)
    if (!tr) return
    const t = document.createElement('tbody'); t.innerHTML = rowHtml(f, selected.has(f.key))
    const n = t.firstElementChild
    tr.replaceWith(n)
    fitTags(n)
  }
  // Dataverse takes about 8 s per component; after the first one, the pace so far is used.
  const timeLeft = () => {
    if (!deleting) return ''
    const left = deleting.total - deleting.done, per = deleting.done ? (performance.now() - deleting.started) / 1000 / deleting.done : 8.5
    const sec = Math.round(left * per)
    return left ? ` · about ${sec < 60 ? 'a minute or less' : `${Math.round(sec / 60)} min`} left` : ''
  }
  function syncMini() {
    if (mini.hidden) return
    mini.innerHTML = deleting ? `<span class="spin"></span><span>Deleting unmanaged layers · ${deleting.done} of ${deleting.total}<small>${esc(timeLeft())}</small></span>`
      : `<span class="ok">${icon('okc', 20)}</span><span>Deleting finished <small>· Select to see the results</small></span>`
    mini.title = 'Open the Unmanaged layers window'
  }
  mini.onclick = () => show()
  function syncSelection() {
    syncMini()
    const rows = drawnRows(), pick = rows.filter(selectable)
    const n = result ? result.findings.filter((f) => selected.has(f.key) && selectable(f)).length : 0, shownSel = rows.filter((f) => selected.has(f.key) && selectable(f)).length, hidden = n - shownSel
    $('all').checked = pick.length > 0 && pick.every((f) => selected.has(f.key))
    $('all').indeterminate = !$('all').checked && pick.some((f) => selected.has(f.key))
    $('all').disabled = IS_DEV || !!deleting || scanning || !pick.length
    for (const tr of root.querySelectorAll('#rows tr[data-k]')) tr.classList.toggle('sel', selected.has(tr.dataset.k))
    const tooMany = n > CONFIG.maxRemovePerRun
    $('selClear').hidden = !n || !!deleting
    $('stopBtn').hidden = !deleting
    $('stopBtn').disabled = !!(deleting && deleting.stop)
    $('stopBtn').textContent = deleting && deleting.stop ? 'Stopping…' : 'Stop deleting'
    $('delBtn').disabled = !n || !!deleting || scanning || tooMany
    $('delBtn').innerHTML = deleting ? `<span class="spin"></span> Deleting…` : `${icon('trash', 20)} ${n > 1 ? `Delete ${n} unmanaged layers` : 'Delete unmanaged layer'}`
    const m = $('selMsg')
    m.className = 'msg' + (tooMany ? ' bad' : '')
    m.innerHTML = scanning ? `<span>Large solutions can take a minute.</span>`
      : deleting ? `<span class="spin" style="color:var(--brand)"></span><span><b>Deleting ${Math.min(deleting.done + 1, deleting.total)} of ${deleting.total}</b>${deleting.current ? `: ${esc(deleting.current)}` : ''}${deleting.stop ? ' · stopping after this one' : timeLeft()}<span class="quiet"> · You can close this window; deleting continues.</span></span>`
      : tooMany ? `<span><b>${n.toLocaleString()} selected</b> · You can delete up to ${CONFIG.maxRemovePerRun} at a time.</span>`
      : n ? `<span><b>${plural(n, 'component')} selected</b>${hidden ? `<span class="quiet"> · ${hidden} hidden by the search or filters</span>` : ''}</span>`
      : active().length ? `<span>Click a row to open its solution layers, or What changed to see and compare its layers.${IS_DEV ? ' Deleting is turned off in development environments.' : ' Tick rows to delete their unmanaged layer.'}</span>` : ''
  }
  function renderBanners() {
    const b = []
    if (result.typesFailed.length) b.push(`<div class="banner warn"><span class="ic">${icon('warn', 20)}</span><div class="txt"><b>Some parts couldn't be read, so this list might be incomplete.</b> Scan again in a moment. <details><summary>${icon('chevron', 12)} Details</summary><div class="err-box">${result.typesFailed.map(esc).join('<br>')}</div></details></div></div>`)
    const na = result.noAccess || []
    if (na.length) b.push(`<div class="banner"><span class="ic">${icon('info', 20)}</span><div class="txt"><b>Not checked: ${esc(na.map((x) => x.type).join(', '))}.</b> Your security role can't read ${na.length === 1 ? 'this type' : 'these types'} (${esc([...new Set(na.map((x) => x.privilege))].join(', '))}), so ${na.length === 1 ? 'it was' : 'they were'} skipped. Everything else was checked.</div></div>`)
    const unread = result.findings.filter((f) => !f.detailsLoaded && !f.deleted), left = unread.length, unconfirmed = unread.filter((f) => f.fromSummary).length
    const readN = result.findings.filter((f) => f.detailsLoaded && !f.deleted).length
    if (left) b.push(`<div class="banner"><span class="ic">${icon('info', 20)}</span><div class="txt">What changed is shown for ${plural(readN, 'component')}. ${plural(left, 'more isn’t', 'more aren’t')} read yet${unconfirmed ? `; ${unconfirmed === left ? (left === 1 ? 'it was' : 'they were') : `${unconfirmed.toLocaleString()} of them were`} flagged only by the solution summary and might have no unmanaged layer of ${unconfirmed === 1 ? 'its' : 'their'} own` : ''}.</div><button class="btn" id="details">Read ${Math.min(left, CONFIG.autoDetails).toLocaleString()} more</button></div>`)
    if (result.warnings.length) b.push(`<div class="banner"><span class="ic">${icon('info', 20)}</span><div class="txt">${result.warnings.map(esc).join(' ')}</div></div>`)
    $('banners').innerHTML = b.join('')
    if ($('details')) $('details').onclick = () => withBusy(async () => {
      $('details').disabled = true; $('details').innerHTML = '<span class="spin"></span> Reading…'
      const next = result.findings.filter((f) => !f.detailsLoaded && !f.deleted)   // the ones flagged only by the summary first
      try { await loadDetails(result, [...next.filter((f) => f.fromSummary), ...next.filter((f) => !f.fromSummary)].slice(0, CONFIG.autoDetails), () => {}) } catch (e) { toast(e.message, { kind: 'warn', sticky: true }) }
      const still = new Set(result.findings.map((f) => f.key))
      for (const k of [...selected]) if (!still.has(k)) selected.delete(k)   // rows that turned out to have no unmanaged layer
      renderResults()
    }).then(() => { if (view === 'pick') renderPickBar() })
  }
  function subtitle() {
    const removed = result.findings.filter((f) => f.deleted).length, all = shown().filter((f) => !f.deleted).length, n = active().length
    const filtered = Object.keys(filters).length || query()
    return `${scanScope} · Scanned in ${result.seconds.toFixed(1)} s${removed ? ` · ${removed} deleted` : ''}${filtered ? ` · showing ${all.toLocaleString()} of ${n.toLocaleString()}` : ''}${shown().length > CONFIG.maxRows ? ` · the first ${CONFIG.maxRows.toLocaleString()} are drawn` : ''}`
  }
  function renderResults() {
    closePop()
    const ok = !scanning && !scanError && result
    progOff(!scanning && !finishing)
    $('again').disabled = $('change').disabled = scanning || !!deleting
    $('again').hidden = $('exportWrap').hidden = !scanning && !ok
    $('change').hidden = scanning
    $('stopScan').hidden = !scanning
    if (scanning) { $('stopScan').disabled = stopReads; $('stopScan').textContent = stopReads ? 'Stopping…' : 'Stop scan' }
    $('exportBtn').disabled = !ok || !!deleting
    $('logBtn').hidden = !lastLog
    $('vRes').dataset.state = scanning ? 'running' : scanError ? 'failed' : result ? 'done' : ''
    const hasRows = ok && result.findings.length > 0
    $('resTools').hidden = !(scanning || hasRows)
    $('q').disabled = scanning || !!deleting
    root.querySelector('#grid thead').hidden = !(scanning || hasRows)
    $('selBar').hidden = !(scanning || (ok && active().length) || deleting)
    $('step').hidden = !scanning
    $('chips').hidden = scanning
    if (scanning) { $('moreWrap').hidden = true; $('fClear').hidden = true }
    $('st').title = scanTypes.length > 3 ? scanTypes.join(', ') : ''
    if (scanning) {
      $('resTitle').textContent = 'Scanning…'
      $('st').textContent = scanScope
      $('banners').innerHTML = ''; $('chips').innerHTML = ''; $('empty').hidden = true
      for (const b of root.querySelectorAll('#grid thead .hb')) b.disabled = true
      $('rows').innerHTML = Array.from({ length: 10 }, (_, i) => `<tr class="sk-row" aria-hidden="true"><td class="c"><i style="width:16px;height:16px;border-radius:3px"></i></td><td><i style="height:10px;width:${60 + (i * 17) % 50}px"></i></td><td><i style="height:12px;width:${120 + (i * 37) % 90}px"></i></td><td><i style="height:10px;width:${90 + (i * 23) % 60}px"></i></td><td><i style="height:10px;width:120px"></i></td><td><i style="height:10px;width:${70 + (i * 29) % 80}px"></i></td><td></td></tr>`).join('')
      $('grid').setAttribute('aria-busy', 'true')
      syncSelection()
      return
    }
    $('grid').setAttribute('aria-busy', 'false')
    if (!ok) {
      const session = /sign-in|session/i.test(scanError)
      $('resTitle').textContent = "Scan didn't finish"
      $('st').textContent = scanScope
      $('banners').innerHTML = ''; $('rows').innerHTML = ''
      $('empty').hidden = false
      $('empty').innerHTML = `<div class="ic bad">${icon('error', 24)}</div><b>${session ? 'Your sign-in has expired' : "Couldn't read the environment"}</b>
        <div style="max-width:560px">${session ? esc(scanError) : "Dataverse didn't respond to one of the requests. This is usually temporary, so try again in a moment."}</div>
        ${session ? '' : `<details><summary>${icon('chevron', 12)} Details</summary><div class="err-box">${esc(scanError)}</div></details>`}
        <div class="acts"><button class="btn" id="errBack">${icon('back', 20)} Change selection</button><button class="btn primary" id="errAgain">${icon('refresh', 20)} Try again</button></div>`
      $('errBack').onclick = () => setView('pick')
      $('errAgain').onclick = () => rescan()
      syncSelection()
      return
    }
    const n = active().length
    $('resTitle').textContent = n ? plural(n, 'unmanaged layer') : 'No unmanaged layers'
    renderFilters(); renderBanners(); renderRows()
    $('st').textContent = subtitle()
  }
  const rescan = () => { if (!busy) runScan(allSolutions.filter((s) => (result ? result.solutions : [...chosen]).includes(s.unique)), result ? result.types || [] : typesChosen(), result ? result.tables || [] : tablesChosen()) }
  $('q').addEventListener('input', () => { if (result) { keepDeleted.clear(); renderRows(); $('st').textContent = subtitle() } })
  root.addEventListener('change', (e) => {
    const el = e.target
    if (!el.closest || !el.closest('#vRes')) return
    if (el.dataset && el.dataset.k) { el.checked ? selected.add(el.dataset.k) : selected.delete(el.dataset.k); syncSelection() }
    else if (el.id === 'all') { for (const f of drawnRows()) if (selectable(f)) el.checked ? selected.add(f.key) : selected.delete(f.key); for (const c of root.querySelectorAll('#rows input[data-k]')) c.checked = selected.has(c.dataset.k); syncSelection() }
  })
  // A click on a row (not on its tick box, a link or a button) opens the component's solution layers in a new tab;
  // What changed and the changes button open its layers and changes here.
  $('rows').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]')
    if (v) { const f = result && result.findings.find((x) => x.key === v.dataset.view); if (f) openSheet(f); return }
    const tr = e.target.closest('tr[data-link]')
    if (!tr || e.target.closest('td.c') || e.target.closest('a,button') || e.detail > 1) return
    const sel = root.getSelection ? root.getSelection() : document.getSelection()
    if (sel && String(sel).trim()) return   // selecting text to copy it does not open a tab
    window.open(tr.dataset.link, '_blank', 'noopener')
  })
  $('selClear').onclick = () => { selected.clear(); for (const c of root.querySelectorAll('#rows input[data-k]')) c.checked = false; syncSelection() }
  $('again').onclick = rescan
  $('change').onclick = () => { if (!scanning && !deleting) setView('pick') }
  $('stopScan').onclick = () => { if (scanning && !stopReads) { stopAllReads(); $('stopScan').disabled = true; $('stopScan').textContent = 'Stopping…'; $('stepTxt').textContent = 'Stopping…' } }
  $('exportBtn').onclick = (e) => { e.stopPropagation(); if ($('exportMenu').hidden) openMenu($('exportBtn'), $('exportMenu')); else closeMenus() }
  $('csv').onclick = () => { closeMenus(); download(`unmanaged-layers-${ORG}-${stamp()}.csv`, toCsv(shown().filter((f) => !f.deleted)), 'text/csv') }
  $('layersBtn').onclick = () => { closeMenus(); download(`unmanaged-layers-all-layers-${ORG}-${stamp()}.csv`, layersCsv(shown().filter((f) => !f.deleted), solNameU), 'text/csv') }
  $('json').onclick = () => { closeMenus(); download(`unmanaged-layers-${ORG}-${stamp()}.json`, exportJson(result), 'application/json') }
  $('logBtn').onclick = () => { closeMenus(); if (lastLog) download(`unmanaged-layers-deleted-${ORG}-${stamp()}.csv`, lastLog, 'text/csv') }

  // ---- a component's layers and what changed, as in Solution Layers Explorer: the comparison of any two layers
  // property by property (XML laid out one attribute per line, JSON indented, web resource content decoded), the list
  // of layers, and each layer's Changes, All properties and Children data.
  const SYSTEM_KEYS = new Set(['modifiedon', 'modifiedby', 'modifiedonbehalfby', 'createdon', 'createdby', 'createdonbehalfby', 'versionnumber', 'overwritetime',
    'solutionid', 'supportingsolutionid', 'componentstate', 'ismanaged', 'publishedon', 'organizationid'])
  const isSystemKey = (k) => SYSTEM_KEYS.has(lc(k)) || /idunique$/i.test(k)
  const layerCache = new Map()   // "id|layer name" -> every layer with all its data, top first (the last 20 components)
  let layerEpoch = 0              // changes when a removal ran: reads started before it are not kept
  async function fullLayers(p) {
    const k = `${p.id}|${p.kind}`
    if (layerCache.has(k)) { const v = layerCache.get(k); layerCache.delete(k); layerCache.set(k, v); return v }
    placeOk(p.id, p.kind)
    const epoch = layerEpoch
    const rows = (await getAll(`msdyn_componentlayers?$filter=(msdyn_componentid eq '${p.id}' and msdyn_solutioncomponentname eq '${p.kind}')`)).sort((a, b) => b.msdyn_order - a.msdyn_order)
    if (epoch === layerEpoch) { layerCache.set(k, rows); while (layerCache.size > 20) layerCache.delete(layerCache.keys().next().value) }
    return rows
  }
  const parseJson = (t) => { try { return t ? JSON.parse(t, exactNumbers) : null } catch { return null } }
  const attrsOf = (t) => { const j = parseJson(t), m = new Map(); for (const a of (j && Array.isArray(j.Attributes) && j.Attributes) || []) if (a && typeof a.Key === 'string') m.set(a.Key, a.Value); return m }
  // Same value whatever the order of an object's keys (as Solution Layers Explorer's DeepEquals).
  const safeJson = (v, n) => { try { return JSON.stringify(v, null, n) } catch { return String(v) } }
  const stable = (v) => { try { return JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x)) } catch { return String(Math.random()) } }   // too deep: counted as different
  function scalarText(v, depth = 0) {
    if (depth > 40) return safeJson(v)
    if (v === null || v === undefined) return ''
    if (typeof v !== 'object') return String(v)
    if ('Id' in v && 'LogicalName' in v) return `${v.LogicalName} ${v.Id}${v.Name ? ` (${v.Name})` : ''}`   // a lookup
    const keys = Object.keys(v)
    if (keys.length === 1 && 'Value' in v) return scalarText(v.Value, depth + 1)   // a choice or a number
    if ('Value' in v && 'CanBeChanged' in v) return `${scalarText(v.Value, depth + 1)} (can be changed: ${v.CanBeChanged})`   // a managed property
    return safeJson(v, 2)
  }
  const escXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const escAttr = (t) => escXml(t).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;')
  // XML laid out for reading and comparing: indented, an element with several attributes has one attribute per line.
  // Only the spacing between elements changes. Text is kept exactly as written, and an element whose text matters
  // (text mixed with elements, or xml:space="preserve") is kept as written on one line, so that two different values
  // never look the same.
  function prettyXml(t) {
    if (t.length > 3e6) return null
    let doc
    try { doc = new DOMParser().parseFromString(t, 'application/xml') } catch { return null }
    if (!doc || doc.getElementsByTagName('parsererror').length) return null
    if (doc.doctype) return null   // a DOCTYPE can add default attributes: shown as written instead
    const out = [], decl = /^﻿?[ \t\r\n]*(<\?xml[ \t][^?]*\?>)/.exec(t)
    if (decl) out.push(decl[1])   // the XML declaration (encoding and version) is not part of the parsed document
    const attrs = (n) => [...n.attributes].map((a) => `${a.name}="${escAttr(a.value)}"`)
    const texty = (c) => c.nodeType === 3 || c.nodeType === 4
    const blank = (c) => c.nodeType === 3 && !/[^ \t\r\n]/.test(c.nodeValue)   // XML spacing only
    // A node exactly as written, on one line (apart from line breaks in its own text).
    const flat = (n) => (n.nodeType === 1 ? `<${n.nodeName}${attrs(n).map((a) => ' ' + a).join('')}${n.childNodes.length ? `>${[...n.childNodes].map(flat).join('')}</${n.nodeName}>` : ' />'}`
      : n.nodeType === 3 ? escXml(n.nodeValue) : n.nodeType === 4 ? `<![CDATA[${n.nodeValue}]]>` : n.nodeType === 8 ? `<!--${n.nodeValue}-->` : n.nodeType === 7 ? `<?${n.nodeName} ${n.nodeValue}?>` : '')
    const walk = (n, d) => {
      const pad = '  '.repeat(d)
      if (n.nodeType === 1) {
        const at = attrs(n), kids = [...n.childNodes]
        const head = at.length > 1 ? [`${pad}<${n.nodeName}`, ...at.map((a) => `${pad}    ${a}`)] : [`${pad}<${n.nodeName}${at.length ? ' ' + at[0] : ''}`]
        if (!kids.length) { head[head.length - 1] += ' />'; out.push(...head); return }
        // Text only, text among elements, spacing within a line (such as a space between two words in SVG text), or
        // spacing that must be kept: the content exactly as written. Line breaks and indentation between elements go.
        if (n.getAttribute('xml:space') === 'preserve' || kids.every(texty) || kids.some((c) => texty(c) && (!blank(c) || !/[\r\n]/.test(c.nodeValue)))) { head[head.length - 1] += `>${kids.map(flat).join('')}</${n.nodeName}>`; out.push(...head); return }
        head[head.length - 1] += '>'
        out.push(...head)
        for (const c of kids) if (!blank(c)) walk(c, d + 1)   // only the spacing between elements is left out
        out.push(`${pad}</${n.nodeName}>`)
      } else { const s = flat(n); if (s) out.push(pad + s) }
    }
    try { for (const c of doc.childNodes) walk(c, 0) } catch { return null }   // too deep
    return out.length > 200000 ? null : out.join('\n')
  }
  // JSON indented without changing it: numbers, strings and the order of keys stay exactly as written (parsing and
  // writing it again would round large numbers and reorder some keys). t must be valid JSON.
  function indentJson(t) {
    const str = /"(?:\\.|[^"\\])*"/y
    let out = '', depth = 0
    const nl = () => '\n' + '  '.repeat(depth)
    for (let i = 0; i < t.length; i++) {
      const c = t[i]
      if (c === '"') { str.lastIndex = i; const m = str.exec(t); if (!m) return null; out += m[0]; i += m[0].length - 1 }
      else if (c === '{' || c === '[') {
        let j = i + 1
        while (/[ \t\r\n]/.test(t[j] || '')) j++
        if (t[j] === (c === '{' ? '}' : ']')) { out += c + t[j]; i = j } else { depth++; out += c + nl() }
      } else if (c === '}' || c === ']') { depth--; out += nl() + c }
      else if (c === ',') out += ',' + nl()
      else if (c === ':') out += ': '
      else if (!/[ \t\r\n]/.test(c)) out += c
    }
    return out
  }
  const b64Text = (v) => { try { return new TextDecoder('utf-8').decode(Uint8Array.from(atob(v.replace(/\s/g, '')), (c) => c.charCodeAt(0))).replace(/^\ufeff/, '') } catch { return null } }
  const WR_IMAGE = { 5: 'image/png', 6: 'image/jpeg', 7: 'image/gif', 10: 'image/x-icon' }
  // A property's value as text for comparing; web resource content decoded (images are shown as images).
  // exact: the value as stored, not laid out (web resource content still decoded), for Copy.
  function valueView(key, v, attrs, kind, exact = false) {
    if (lc(kind) === 'webresource' && key === 'content' && typeof v === 'string' && /^[A-Za-z0-9+/=\s]*$/.test(v)) {
      const t = Number(scalarText(attrs.get('webresourcetype'))), bytes = Math.round(v.replace(/\s/g, '').length * 3 / 4)
      if (WR_IMAGE[t]) return exact ? { text: v } : { image: `data:${WR_IMAGE[t]};base64,${v.replace(/\s/g, '')}`, text: `(image, ${bytes.toLocaleString()} bytes)` }
      if (t === 8) return { text: exact ? v : `(Silverlight file, ${bytes.toLocaleString()} bytes)` }
      const d = b64Text(v)
      if (d != null) return { text: !exact && [4, 9, 11, 12].includes(t) ? prettyXml(d) || d : d, note: 'decoded from base64' }
    }
    const text = scalarText(v)
    if (typeof v === 'string' && !exact) {
      const t = text.trim()
      if (t.startsWith('<') && t.endsWith('>')) { const x = prettyXml(t); if (x) return { text: x, note: 'XML laid out one attribute per line' } }
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) { const j = parseJson(t); if (j && typeof j === 'object') { const x = indentJson(t); if (x) return { text: x, note: 'JSON indented' } } }
    }
    return { text }
  }
  // Two different values that look the same once laid out (spacing only, or details the short form leaves out): both
  // shown as stored instead, so the difference can be seen.
  function asStored(r, kind, c) {
    let a = valueView(r.k, r.va, c.ma, kind, true), b = valueView(r.k, r.vb, c.mb, kind, true)
    if (a.text === b.text) { a = { text: typeof r.va === 'string' ? r.va : safeJson(r.va, 2) }; b = { text: typeof r.vb === 'string' ? r.vb : safeJson(r.vb, 2) } }
    const eol = (x) => x.replace(/\r\n?/g, '\n'), note = a.text !== b.text && eol(a.text) === eol(b.text) ? 'only the line endings differ (CR shows a Windows line ending)' : 'shown as stored: laid out, the two look the same'
    return [{ ...a, note }, { ...b, note }]
  }
  // Line differences (Myers), after taking out the lines both start and end with. Each step: [0 same | -1 removed | 1 added, line in a, line in b].
  function diffLines(a, b) {
    let s = 0
    while (s < a.length && s < b.length && a[s] === b[s]) s++
    let ea = a.length, eb = b.length
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
    const A = a.slice(s, ea), B = b.slice(s, eb), N = A.length, M = B.length, maxD = Math.min(N + M, 2000)
    const v = new Int32Array(2 * maxD + 3), off = maxD + 1, snaps = []
    let D = -1
    search: for (let d = 0; d <= maxD; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
        let y = x - k
        while (x < N && y < M && A[x] === B[y]) { x++; y++ }
        v[off + k] = x
        if (x >= N && y >= M) { snaps.push(v.slice(off - d, off + d + 1)); D = d; break search }
      }
      snaps.push(v.slice(off - d, off + d + 1))
    }
    let mid = []
    if (D < 0) mid = [...A.map((_, i) => [-1, i, -1]), ...B.map((_, j) => [1, -1, j])]   // too different: all of one, then all of the other
    else {
      let x = N, y = M
      for (let d = D; d > 0; d--) {
        const prev = snaps[d - 1], get = (k) => prev[k + d - 1], k = x - y
        const down = k === -d || (k !== d && get(k - 1) < get(k + 1)), pk = down ? k + 1 : k - 1, px = get(pk), py = px - pk
        while (x > (down ? px : px + 1) && y > (down ? py + 1 : py)) { x--; y--; mid.push([0, x, y]) }
        mid.push(down ? [1, -1, py] : [-1, px, -1])
        x = px; y = py
      }
      while (x > 0 && y > 0) { x--; y--; mid.push([0, x, y]) }
      mid.reverse()
    }
    const ops = []
    for (let i = 0; i < s; i++) ops.push([0, i, i])
    for (const [t, i, j] of mid) ops.push([t, i < 0 ? -1 : i + s, j < 0 ? -1 : j + s])
    for (let i = 0; i < a.length - ea; i++) ops.push([0, ea + i, eb + i])
    return ops
  }
  // A line of a value as HTML: a carriage return (CR, from Windows line endings) is shown, so a difference in line
  // endings alone can be seen.
  const escLine = (t) => esc(t).replace(/\r/g, '<span class="crm" title="Carriage return (CR)">\u240d</span>')
  // The part of two changed lines that differs, marked.
  function markPair(x, y) {
    let p = 0
    while (p < x.length && p < y.length && x[p] === y[p]) p++
    let q = 0
    while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++
    if (!p && !q) return null
    const m = (t) => escLine(t.slice(0, p)) + (t.length - p - q > 0 ? `<mark>${escLine(t.slice(p, t.length - q))}</mark>` : '') + escLine(t.slice(t.length - q))
    return [m(x), m(y)]
  }
  const dline = (cls, na, nb, sign, html) => `<div class="dl ${cls}"><span class="ln">${na}</span><span class="ln">${nb}</span><span class="sg">${sign}</span><span class="tx">${html || ' '}</span></div>`
  const srow = (cl, nl, tl, cr, nr, tr) => `<div class="sr2"><span class="ln ${cl}">${nl}</span><span class="tx ${cl}">${tl || ' '}</span><span class="ln ${cr}">${nr}</span><span class="tx ${cr}">${tr || ' '}</span></div>`
  function opsHtml(d, from, to) {
    const { ops, a, b, sbs } = d
    let h = '', i = from
    while (i < to) {
      if (ops[i][0] === 0) { const t = escLine(a[ops[i][1]]); h += sbs ? srow('', ops[i][1] + 1, t, '', ops[i][2] + 1, t) : dline('', ops[i][1] + 1, ops[i][2] + 1, ' ', t); i++; continue }
      const dels = [], adds = []
      while (i < to && ops[i][0] !== 0) { (ops[i][0] < 0 ? dels : adds).push(ops[i]); i++ }
      const da = dels.map((o) => escLine(a[o[1]])), db = adds.map((o) => escLine(b[o[2]]))
      for (let j = 0; j < Math.min(dels.length, adds.length); j++) { const m = markPair(a[dels[j][1]], b[adds[j][2]]); if (m) { da[j] = m[0]; db[j] = m[1] } }
      if (sbs) for (let j = 0; j < Math.max(dels.length, adds.length); j++) h += srow(dels[j] ? 'del' : 'nil', dels[j] ? dels[j][1] + 1 : '', da[j], adds[j] ? 'add' : 'nil', adds[j] ? adds[j][2] + 1 : '', db[j])
      else h += dels.map((o, j) => dline('del', o[1] + 1, '', '−', da[j])).join('') + adds.map((o, j) => dline('add', '', o[2] + 1, '+', db[j])).join('')
    }
    return h
  }
  const foldBtn = (id, i, j) => `<button class="fold" data-d="${id}" data-from="${i}" data-to="${j}">${icon('chevron', 12)} ${plural(j - i, 'unchanged line')}</button>`
  const diffs = new Map()   // id -> { a, b, ops, sbs } of the comparisons drawn, for unfolding
  let diffSeq = 0
  // Changed lines with 3 lines around them; longer unchanged stretches folded (select to unfold).
  function diffHtml(d) {
    const id = ++diffSeq, n = d.ops.length, keep = new Uint8Array(n)
    diffs.set(id, d)
    for (let i = 0; i < n; i++) if (d.ops[i][0] !== 0) for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) keep[j] = 1
    let h = '', i = 0, drawn = 0
    while (i < n) {
      let j = i
      while (j < n && keep[j] === keep[i]) j++
      if (keep[i]) {
        if (drawn + (j - i) > MAX_LINES) { const k = i + Math.max(0, MAX_LINES - drawn); h += opsHtml(d, i, k) + `<div class="pop-more">${plural(n - k, 'more line')} of this difference ${n - k === 1 ? "isn't" : "aren't"} shown. Copy the values to compare them in another tool.</div>`; break }
        h += opsHtml(d, i, j); drawn += j - i
      } else h += foldBtn(id, i, j)
      i = j
    }
    return `<div class="diff">${h}</div>`
  }

  const sheet = { f: null, tab: 'compare', place: 0, layers: null, error: '', a: 0, b: 1, onlyDiff: true, hideSystem: true, sbs: false, json: 'changes', jl: 0, open: null, token: null }
  const layerShort = (l) => (l.msdyn_solutionname === 'Active' ? 'Active' : solNameU(l.msdyn_solutionname))
  const solVersion = (u) => (allSolutions.find((s) => s.unique === u) || {}).version || ''
  const layerLabel = (l) => (l.msdyn_solutionname === 'Active' ? 'Active (unmanaged layer)' : `${solNameU(l.msdyn_solutionname)} ${solVersion(l.msdyn_solutionname)}`.trim())
  const when = (t) => (!t || /^1900/.test(t) ? '—' : new Date(t).toLocaleString())
  function openSheet(f) {
    if (scanning || deleting) return
    closePop(); closeMenus()
    const keepTab = sheet.f ? sheet.tab : 'compare'
    sheet.f = f; sheet.tab = keepTab
    const pl = places(f), i = pl.findIndex((p) => (f.activeKinds || []).includes(p.kind))
    sheet.place = i >= 0 ? i : pl.length - 1
    $('sheet').hidden = false
    $('vRes').inert = true
    renderSheetHead()
    loadSheet()
    clearTimeout(sheetFocus); sheetFocus = setTimeout(() => { if (!$('sheet').hidden) $('shTitle').focus() }, 30)
  }
  let sheetFocus = 0
  function closeSheet() {
    clearTimeout(sheetFocus)   // a focus still pending from opening must not land after closing
    if ($('sheet').hidden) return
    const key = sheet.f && sheet.f.key
    $('sheet').hidden = true
    $('vRes').inert = false
    sheet.f = null; sheet.token = null; diffs.clear()
    const back = key && root.querySelector(`#rows tr[data-k="${CSS.escape(key)}"] .vb`)
    setTimeout(() => (back || $('resTitle')).focus(), 0)
  }
  function renderSheetHead() {
    const f = sheet.f, list = drawnRows(), i = list.findIndex((x) => x.key === f.key)
    $('shTitle').textContent = f.display || f.schema || '(no name)'
    $('shSub').textContent = [f.type, f.display && f.schema ? f.schema : '', f.tableLabel, f.solutions].filter(Boolean).join(' · ')
    $('shPrev').disabled = i <= 0; $('shNext').disabled = i < 0 || i >= list.length - 1
    $('shPos').textContent = i >= 0 ? `${i + 1} of ${list.length}` : ''
    const link = layersUrl(f)
    $('shOpen').hidden = !link
    if (link) { $('shOpen').href = link; $('shOpen').title = linkTitle(f, link) }
    $('shDel').hidden = IS_DEV || cannotDelete(f) || !!f.deleted
    $('shDel').disabled = !selectable(f) || busy
    for (const t of root.querySelectorAll('#shTabs .tab')) { const on = t.dataset.tab === sheet.tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1 }
    $('shPanel').setAttribute('aria-labelledby', `tab-${sheet.tab}`)
  }
  async function loadSheet() {
    const f = sheet.f, p = places(f)[sheet.place], token = {}
    sheet.token = token; sheet.layers = null; sheet.error = ''; sheet.open = null
    renderSheetBody()
    try { const l = await fullLayers(p); if (sheet.token !== token) return; sheet.layers = l }
    catch (e) { if (sheet.token !== token) return; sheet.error = e.message }
    const L = sheet.layers || [], ia = L.findIndex((l) => l.msdyn_solutionname === 'Active')
    sheet.a = ia >= 0 ? ia : 0                       // by default the unmanaged layer, against the managed layer right under it
    sheet.b = Math.min(L.length - 1, sheet.a + 1)
    if (sheet.b === sheet.a) sheet.b = Math.max(0, sheet.a - 1)
    sheet.jl = sheet.a
    renderSheetBody()
  }
  const opts = (L, sel) => L.map((l, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(`${l.msdyn_order} · ${layerLabel(l)}`)}</option>`).join('')
  function placeSwitch() {
    const pl = places(sheet.f)
    if (pl.length < 2) return ''
    return `<div class="seg" role="group" aria-label="Part of the relationship">${pl.map((p, i) => `<button data-place="${i}" aria-pressed="${i === sheet.place}">${p.kind === 'Relationship' ? 'Cascade settings' : 'Definition'}</button>`).join('')}</div>`
  }
  function renderSheetBody() {
    if (!sheet.f) return
    renderSheetHead()
    const tools = $('shTools'), body = $('shBody'), L = sheet.layers
    diffs.clear()
    if (sheet.error) { tools.innerHTML = placeSwitch(); body.innerHTML = `<div class="empty"><div class="ic bad">${icon('error', 24)}</div><b>Couldn't read the layers</b><div class="err-box">${esc(sheet.error)}</div><div class="acts"><button class="btn" id="shRetry">${icon('refresh', 20)} Try again</button></div></div>`; return }
    if (!L) { tools.innerHTML = placeSwitch(); body.innerHTML = `<div class="empty"><span class="spin" style="color:var(--brand);width:20px;height:20px"></span><div>Reading the layers…</div></div>`; return }
    if (!L.length) { tools.innerHTML = placeSwitch(); body.innerHTML = `<div class="empty"><div class="ic">${icon('info', 22)}</div><b>No layers</b><div>Dataverse has no layers for this component under the name ${esc(places(sheet.f)[sheet.place].kind)}.</div></div>`; return }
    if (sheet.tab === 'layers') renderLayersTab(L)
    else if (sheet.tab === 'json') renderJsonTab(L)
    else renderCompareTab(L)
  }

  // What changed: the two layers' properties side by side.
  function compareRows(L) {
    const A = L[sheet.a], B = L[sheet.b], ma = attrsOf(A.msdyn_componentjson), mb = attrsOf(B.msdyn_componentjson)
    const keys = [...new Set([...ma.keys(), ...mb.keys()])]
    const rows = keys.map((k) => { const inA = ma.has(k), inB = mb.has(k); return { k, inA, inB, same: inA && inB && stable(ma.get(k)) === stable(mb.get(k)), system: isSystemKey(k), va: ma.get(k), vb: mb.get(k) } })
    rows.sort((x, y) => (x.same - y.same) || (x.system - y.system) || cmpText(x.k, y.k))
    return { A, B, ma, mb, rows }
  }
  function renderCompareTab(L) {
    const tools = $('shTools'), body = $('shBody')
    // Each picker offers every layer except the one in the other picker; with two layers there is nothing to pick.
    const pick = (id, sel, other, cls, title) => (L.length > 2 ? `<select class="sel ${cls}" id="${id}" title="${title}" aria-label="${id === 'cmpB' ? 'Compare (shown in red)' : 'With (shown in green)'}">${L.map((l, i) => (i === other ? '' : `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(`${l.msdyn_order} · ${layerLabel(l)}`)}</option>`)).join('')}</select>`
      : `<span class="lchip ${cls}" title="${title}">${esc(`${L[sel].msdyn_order} · ${layerLabel(L[sel])}`)}</span>`)
    tools.innerHTML = `${placeSwitch()}${L.length > 1 ? `<span class="fld">Compare ${pick('cmpB', sheet.b, sheet.a, 'old', 'Shown in red')}</span><span class="fld">with ${pick('cmpA', sheet.a, sheet.b, 'new', 'Shown in green')}</span>
      <button class="btn subtle icon" id="cmpSwap" title="Swap the two layers" aria-label="Swap the two layers">${icon('swap', 20)}</button>
      <div class="seg" role="group" aria-label="Layout"><button data-sbs="0" aria-pressed="${!sheet.sbs}">Inline</button><button data-sbs="1" aria-pressed="${sheet.sbs}">Side by side</button></div>
      <span class="spacer"></span><label class="chk"><input type="checkbox" id="cmpDiff" ${sheet.onlyDiff ? 'checked' : ''}> Only differences</label><label class="chk"><input type="checkbox" id="cmpSys" ${sheet.hideSystem ? 'checked' : ''}> Hide system values</label>` : ''}`
    if (L.length < 2) { body.innerHTML = `<div class="empty"><div class="ic">${icon('info', 22)}</div><b>Only one layer</b><div>${esc(layerLabel(L[0]))} is this component's only layer, so there is nothing to compare. Its data is under JSON.</div></div>`; return }
    if (sheet.a === sheet.b) { body.innerHTML = `<div class="empty"><div class="ic">${icon('info', 22)}</div><b>Choose two different layers</b></div>`; return }
    const c = compareRows(L)
    sheet.cmp = c
    const differ = c.rows.filter((r) => !r.same), sys = differ.filter((r) => r.system).length
    const list = c.rows.filter((r) => (!sheet.onlyDiff || !r.same) && (!sheet.hideSystem || !r.system))
    if (!sheet.open) sheet.open = new Set(list.filter((x) => !x.same).slice(0, 3).map((r) => r.k))   // the first changes open
    const real = differ.length - sys
    const head = `<div class="sh-note">${icon('info')}<span>${real ? `<b>${plural(real, 'property differs', 'properties differ')}</b>` : '<b>No property differs</b>'} between ${esc(layerLabel(c.B))} (red) and ${esc(layerLabel(c.A))} (green).${sys ? ` ${plural(sys, 'system value')}, such as Modified on, also ${sys === 1 ? 'differs' : 'differ'}${sheet.hideSystem ? ` and ${sys === 1 ? 'is' : 'are'} hidden` : ''}.` : ''}</span></div>`
    body.innerHTML = head + (list.length ? `<div class="props">${list.map((r) => propHtml(r, c)).join('')}</div>`
      : `<div class="empty"><div class="ic ok">${icon('check', 24)}</div><b>${differ.length ? 'Only system values differ' : 'The two layers are the same'}</b>${differ.length ? '<div>Clear "Hide system values" to see them.</div>' : ''}</div>`)
  }
  function propHtml(r, c) {
    const open = sheet.open.has(r.k)
    const state = r.same ? ['', 'Same'] : !r.inA ? ['', `Only in ${layerShort(c.B)}`] : !r.inB ? ['', `Only in ${layerShort(c.A)}`] : ['amb', 'Changed']
    return `<div class="prop${open ? ' ex' : ''}" data-k="${esc(r.k)}"><button class="prop-h" aria-expanded="${open}"><span class="cv">${icon('chevron', 12)}</span><span class="k">${esc(r.k)}</span>${r.system ? '<span class="tag">System</span>' : ''}<span class="spacer"></span><span class="pill ${state[0]}">${esc(state[1])}</span></button>${open ? `<div class="prop-b">${propBody(r, c)}</div>` : ''}</div>`
  }
  const BIG = 1000000, MAX_LINES = 3000   // characters of a value compared on the screen; lines of a difference drawn
  function propBody(r, c) {
    try { return propBodyOf(r, c) } catch (e) { return `<div class="kv"><span class="lb">Error</span><span class="val">This value couldn't be shown (${esc(e.message)}). It is in the JSON tab.</span></div>` }
  }
  function propBodyOf(r, c) {
    const kind = c.A.msdyn_solutioncomponentname || places(sheet.f)[sheet.place].kind
    let xa = r.inA ? valueView(r.k, r.va, c.ma, kind) : null, xb = r.inB ? valueView(r.k, r.vb, c.mb, kind) : null
    if (xa && xb && !r.same && !xa.image && !xb.image && xa.text === xb.text) [xa, xb] = asStored(r, kind, c)
    const la = esc(layerShort(c.A)), lb = esc(layerShort(c.B))
    let img = ''
    if ((xa && xa.image) || (xb && xb.image)) img = `<div class="imgs">${[[xb, lb], [xa, la]].map(([x, l]) => (x && x.image ? `<figure><img alt="" src="${esc(x.image)}"><figcaption>${l}</figcaption></figure>` : '')).join('')}</div>`
    const ta = xa ? xa.text : '', tb = xb ? xb.text : ''
    const note = (xa && xa.note) || (xb && xb.note)
    const copy = `${r.inB ? `<button class="link" data-copy="b" title="Copy the value in ${lb}">Copy ${lb}</button>` : ''}${r.inA ? `<button class="link" data-copy="a" title="Copy the value in ${la}">Copy ${la}</button>` : ''}`
    if (ta.length > BIG || tb.length > BIG) return `${img}<div class="legend"><span>This value is too large to compare here (${Math.max(ta.length, tb.length).toLocaleString()} characters). Copy it to compare it in another tool.</span><span class="spacer"></span>${copy}</div>`
    if (!/\n/.test(ta + tb) && ta.length <= 200 && tb.length <= 200) {
      const val = (x, t, cls) => (x ? `<span class="val ${r.same ? '' : cls}">${t ? escLine(t) : '<i>(empty)</i>'}</span>` : `<span class="val"><i>not in this layer</i></span>`)
      return `${img}<div class="kv"><span class="lb" title="${lb}">${lb}</span>${val(xb, tb, 'old')}<span class="lb" title="${la}">${la}</span>${val(xa, ta, 'new')}</div>`
    }
    const d = { a: xb ? tb.split('\n') : [], b: xa ? ta.split('\n') : [], sbs: sheet.sbs }   // a property in one layer only: that side only
    d.ops = diffLines(d.a, d.b)
    let changes = 0
    for (let i = 0; i < d.ops.length;) { if (!d.ops[i][0]) { i++; continue } let x = 0, y = 0; while (i < d.ops.length && d.ops[i][0]) { d.ops[i][0] < 0 ? x++ : y++; i++ } changes += Math.max(x, y) }
    return `${img}<div class="legend"><span class="lo">− ${lb}</span><span class="ln2">+ ${la}</span><span>${changes ? plural(changes, 'line differs', 'lines differ') : 'The text is the same'}${note ? ` · ${esc(note)}` : ''}</span><span class="spacer"></span>${copy}</div>${diffHtml(d)}`
  }
  function redrawProp(k) {
    const el = root.querySelector(`#shBody .prop[data-k="${CSS.escape(k)}"]`), r = sheet.cmp && sheet.cmp.rows.find((x) => x.k === k)
    if (!el || !r) return
    const t = document.createElement('div'); t.innerHTML = propHtml(r, sheet.cmp)
    el.replaceWith(t.firstElementChild)
  }

  // Layers: as on the maker portal's Solution layers page.
  function renderLayersTab(L) {
    $('shTools').innerHTML = placeSwitch()
    const ia = L.findIndex((l) => l.msdyn_solutionname === 'Active')
    $('shBody').innerHTML = `<table class="lt"><thead><tr><th>Order</th><th>Solution</th><th>Publisher</th><th>Layer</th><th>Version</th><th>Overwrite time</th><th>Changed properties</th><th><span class="sr">Actions</span></th></tr></thead><tbody>${L.map((l, i) => {
      const act = l.msdyn_solutionname === 'Active'
      return `<tr><td>${esc(l.msdyn_order)}</td><td><div class="one"><b>${esc(act ? 'Active' : solNameU(l.msdyn_solutionname))}</b></div>${act ? '<div class="lg">Unmanaged customizations</div>' : `<div class="lg">${esc(l.msdyn_solutionname)}</div>`}</td><td>${esc(l.msdyn_publishername || '')}</td>
        <td>${act ? '<span class="pill amb">Unmanaged</span>' : '<span class="pill">Managed</span>'}</td><td>${esc(act ? '' : solVersion(l.msdyn_solutionname))}</td><td class="nw">${esc(when(l.msdyn_overwritetime))}</td><td>${changedKeys(l).length}</td>
        <td><div class="acts">${ia >= 0 && i !== ia ? `<button class="link" data-cmp="${i}">Compare with Active</button>` : ''}<button class="link" data-jl="${i}">JSON</button></div></td></tr>`
    }).join('')}</tbody></table>`
  }

  // JSON: a layer's Changes, All properties or Children, as Solution Layers Explorer shows them.
  const JSON_FIELD = { changes: ['msdyn_changes', 'Changes'], all: ['msdyn_componentjson', 'All properties'], children: ['msdyn_children', 'Children'] }
  function highlightJson(t) {   // only for valid JSON (indentJson of JSON that parsed): outside strings there are only brackets, numbers and words
    if (t.length > 500000) return esc(t)
    return t.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, colon) => (str ? `<span class="${colon ? 'k' : 's'}">${esc(str)}</span>${colon || ''}` : /^[tfn]/.test(m) ? `<span class="b">${m}</span>` : `<span class="n">${m}</span>`))
  }
  // Lists of records inside Children (a role's privileges, a choice's labels and values), as tables.
  const DEPTH = { 1: 'User', 2: 'Business unit', 4: 'Parent: child business units', 8: 'Organization' }
  function childTables(j) {
    const out = []
    const visit = (v, path, depth) => {
      if (!v || typeof v !== 'object' || depth > 5 || out.length >= 10) return
      const ents = Array.isArray(v) ? v : Array.isArray(v.Entities) ? v.Entities : null
      if (ents && ents.length && ents.every((e) => e && Array.isArray(e.Attributes))) { out.push({ path: path || 'Records', rows: ents.map((e) => new Map(e.Attributes.filter((a) => a && typeof a.Key === 'string').map((a) => [a.Key, a.Value]))) }); return }
      for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k, depth + 1)
    }
    visit(j, '', 0)
    return out
  }
  function childTablesHtml(j) {
    return childTables(j).map((t) => {
      const freq = new Map()
      for (const r of t.rows) for (const k of r.keys()) freq.set(k, (freq.get(k) || 0) + 1)
      const cols = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0])
      const cell = (k, v) => { const s = scalarText(v); return esc(k === 'privilegedepthmask' && Object.hasOwn(DEPTH, s) ? `${DEPTH[s]} (${s})` : s.length > 160 ? s.slice(0, 160) + '…' : s) }
      return `<div class="ct"><h4>${esc(t.path)} <span class="quiet">(${t.rows.length.toLocaleString()})</span></h4><div style="overflow:auto"><table class="lt"><thead><tr>${cols.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${t.rows.slice(0, 500).map((r) => `<tr>${cols.map((k) => `<td>${r.has(k) ? cell(k, r.get(k)) : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${t.rows.length > 500 ? `<div class="pop-more">The first 500 are shown; all of them are in the JSON below.</div>` : ''}</div>`
    }).join('')
  }
  function jsonText(L) {
    const raw = (L[sheet.jl] || {})[JSON_FIELD[sheet.json][0]] || '', j = parseJson(raw)
    return { raw, j, text: j && typeof j === 'object' ? indentJson(raw) || raw : raw }
  }
  function renderJsonTab(L) {
    if (sheet.jl >= L.length) sheet.jl = 0
    $('shTools').innerHTML = `${placeSwitch()}<label class="fld">Layer <select class="sel" id="jsLayer">${opts(L, sheet.jl)}</select></label>
      <div class="seg" role="group" aria-label="Data">${Object.entries(JSON_FIELD).map(([k, [, t]]) => `<button data-js="${k}" aria-pressed="${sheet.json === k}">${t}</button>`).join('')}</div>
      <span class="spacer"></span><button class="btn" id="jsCopy">${icon('copy', 20)} Copy</button><button class="btn" id="jsSave">${icon('download', 20)} Download</button>`
    const { j, text } = jsonText(L), what = JSON_FIELD[sheet.json][1]
    $('jsCopy').disabled = $('jsSave').disabled = !text
    $('shBody').innerHTML = !text ? `<div class="empty"><div class="ic">${icon('info', 22)}</div><b>No ${esc(what.toLowerCase())}</b><div>${esc(layerLabel(L[sheet.jl]))} has no ${esc(what.toLowerCase())} data.</div></div>`
      : `${sheet.json === 'children' && j ? (() => { try { return childTablesHtml(j) } catch { return '' } })() : ''}<pre class="code">${j ? highlightJson(text) : esc(text)}</pre>`
  }

  // ---- details: events
  const sheetGo = (step) => { if (!sheet.f) return; const list = drawnRows(), i = list.findIndex((x) => x.key === sheet.f.key), n = i < 0 ? null : list[i + step]; if (n) openSheet(n) }
  $('shBack').onclick = closeSheet
  $('shPrev').onclick = () => sheetGo(-1)
  $('shNext').onclick = () => sheetGo(1)
  $('shDel').onclick = () => { if (sheet.f) confirmDelete([sheet.f]) }
  $('sheet').addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); sheetGo(e.key === 'ArrowUp' ? -1 : 1); return }
    if (e.target.closest('#shTabs') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const tabs = [...root.querySelectorAll('#shTabs .tab')], i = tabs.indexOf(e.target), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
      e.preventDefault(); n.click(); n.focus()
    }
  })
  $('shTabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t && t.dataset.tab !== sheet.tab) { sheet.tab = t.dataset.tab; renderSheetBody() } })
  $('sheet').addEventListener('change', (e) => {
    const id = e.target.id
    if (id === 'cmpA' || id === 'cmpB') { sheet[id === 'cmpA' ? 'a' : 'b'] = Number(e.target.value); sheet.open = null; renderSheetBody() }
    else if (id === 'cmpDiff') { sheet.onlyDiff = e.target.checked; renderSheetBody() }
    else if (id === 'cmpSys') { sheet.hideSystem = e.target.checked; renderSheetBody() }
    else if (id === 'jsLayer') { sheet.jl = Number(e.target.value); renderSheetBody() }
    if (id && $(id) && $(id) !== e.target) $(id).focus()   // drawn again: the same control keeps the focus
  })
  const copyText = async (t, what) => { try { await navigator.clipboard.writeText(t); toast(`Copied ${what}.`) } catch { toast("The browser didn't allow copying.", { kind: 'warn' }) } }
  $('sheet').addEventListener('click', (e) => {
    const t = e.target.closest('button')
    if (!t || !sheet.f) return
    if (t.id === 'shRetry') loadSheet()
    else if (t.id === 'cmpSwap') { [sheet.a, sheet.b] = [sheet.b, sheet.a]; sheet.open = null; renderSheetBody(); const s = $('cmpSwap'); if (s) s.focus() }
    else if (t.dataset.place != null) { const i = Number(t.dataset.place); if (i !== sheet.place) { sheet.place = i; loadSheet().then(() => { const b = $('shTools').querySelector(`[data-place="${i}"]`); if (b) b.focus() }) } }
    else if (t.dataset.sbs != null) { sheet.sbs = t.dataset.sbs === '1'; renderSheetBody(); const b = $('shTools').querySelector(`[data-sbs="${t.dataset.sbs}"]`); if (b) b.focus() }
    else if (t.dataset.js) { sheet.json = t.dataset.js; renderSheetBody(); const b = $('shTools').querySelector(`[data-js="${t.dataset.js}"]`); if (b) b.focus() }
    else if (t.dataset.cmp != null) { const L = sheet.layers; sheet.a = L.findIndex((l) => l.msdyn_solutionname === 'Active'); sheet.b = Number(t.dataset.cmp); sheet.open = null; sheet.tab = 'compare'; renderSheetBody() }
    else if (t.dataset.jl != null) { sheet.jl = Number(t.dataset.jl); sheet.tab = 'json'; renderSheetBody() }
    else if (t.classList.contains('prop-h')) { const k = t.closest('.prop').dataset.k; sheet.open.has(k) ? sheet.open.delete(k) : sheet.open.add(k); redrawProp(k); const h = root.querySelector(`#shBody .prop[data-k="${CSS.escape(k)}"] .prop-h`); if (h) h.focus() }
    else if (t.classList.contains('fold')) {   // unfolds up to 3,000 lines at a time
      const d = diffs.get(Number(t.dataset.d)), from = Number(t.dataset.from), to = Number(t.dataset.to), k = Math.min(to, from + MAX_LINES)
      if (d) { const box = document.createElement('div'); box.innerHTML = opsHtml(d, from, k) + (k < to ? foldBtn(Number(t.dataset.d), k, to) : ''); t.replaceWith(...box.childNodes) }
    }
    else if (t.dataset.copy) {
      const k = t.closest('.prop').dataset.k, r = sheet.cmp && sheet.cmp.rows.find((x) => x.k === k), c = sheet.cmp
      if (!r) return
      // The value as stored (web resource content decoded), not as laid out on the screen, so it can be pasted back as it was.
      const side = t.dataset.copy === 'a', x = valueView(r.k, side ? r.va : r.vb, side ? c.ma : c.mb, c.A.msdyn_solutioncomponentname || places(sheet.f)[sheet.place].kind, true)
      copyText(x.text, `the value in ${layerShort(side ? c.A : c.B)}`)
    }
    else if (t.id === 'jsCopy') copyText(jsonText(sheet.layers).text, JSON_FIELD[sheet.json][1].toLowerCase())
    else if (t.id === 'jsSave') { const f = sheet.f, l = sheet.layers[sheet.jl]; download(`${lc(f.kind)}-${f.id}-${lc(l.msdyn_solutionname)}-${sheet.json}.json`, jsonText(sheet.layers).text, 'application/json') }
  })

  // ---- deleting: one confirmation, like "Remove active customizations" in the maker portal
  const beforeUnload = (e) => { e.preventDefault(); e.returnValue = '' }
  // items: the components to delete (the ticked ones, also those hidden by a filter; or the one shown in the details)
  const tableShort = (f) => { const m = /^(.*) \(([^()]+)\)$/.exec(f.tableLabel || ''); return m ? m[1] : f.tableLabel || f.table }
  function confirmDelete(items) {
    if (busy || IS_DEV || !result) return
    items = items.filter(selectable)
    if (!items.length || items.length > CONFIG.maxRemovePerRun) return
    const one = items.length === 1, shownKeys = new Set(shown().map((f) => f.key))
    let signIn = ''
    if (ON_MAKER) {
      // The borrowed sign-in is renewed only while the portal itself is used; a run that outlasts it stops safely.
      const t = makerToken(conn.host, conn.account), left = t ? t.secondsLeft : 0
      if (left < 60 + 20 * items.length) signIn = `<div class="note amb">${icon('warn')}<span>The maker portal sign-in ends in about ${plural(Math.max(0, Math.floor(left / 60)), 'minute')}, which might not be enough. Reload the page to renew it, or delete fewer at a time.</span></div>`
    }
    openDialog({
      title: one ? 'Delete unmanaged layer?' : `Delete ${items.length} unmanaged layers?`,
      body: `<p>This removes the unmanaged customizations (the Active layer) from ${one ? 'this component' : `these ${items.length} components`}, the same as <b>Remove active customizations</b> on the Solution layers page. ${one ? 'It goes' : 'They go'} back to what the managed solution defines. Managed layers aren't changed.</p>
        ${IS_PROD ? `<div class="note">${icon('warn')}<span>You're deleting in the production environment <b>${esc(ORG)}</b>.</span></div>` : ''}${signIn}
        <div class="dlg-list">${items.map((f) => `<div><span class="t">${esc(f.type)}</span><span class="n">${esc(f.display || f.schema)}</span><span class="s">${esc([f.display && f.schema ? f.schema : '', f.table ? `on ${tableShort(f)}` : '', shownKeys.has(f.key) ? '' : 'hidden by the search or filters'].filter(Boolean).join(' · '))}</span></div>`).join('')}</div>
        <p class="quiet">${one ? '' : 'They are deleted one at a time, in this order. '}You can't undo this. A log of the removed changes can be downloaded afterward.</p>`,
      actions: [{ id: 'dlgOk', label: 'Delete', kind: 'danger' }, { id: 'dlgCancel', label: 'Cancel', focus: true }],
    })
    $('dlgCancel').onclick = () => dlgClose()
    $('dlgOk').onclick = () => { closeSheet(); dlgClose(); runDelete(items); setTimeout(() => $('resTitle').focus(), 20) }
  }
  // In the order shown, top to bottom (whatever the sort); ticked rows hidden by a filter come after, in the scan's order.
  $('delBtn').onclick = () => {
    if (!result) return
    const at = new Map(shown().map((f, i) => [f.key, i])), n = result.findings.length
    confirmDelete(result.findings.map((f, i) => [f, at.has(f.key) ? at.get(f.key) : n + i]).filter(([f]) => selected.has(f.key)).sort((a, b) => a[1] - b[1]).map(([f]) => f))
  }
  $('stopBtn').onclick = () => { if (deleting && !deleting.stop) { deleting.stop = true; syncSelection(); announce('Stopping after the component being deleted now.') } }
  function runDelete(items) {
    withBusy(async () => {
      deleting = { keys: new Set(items.map((f) => f.key)), total: items.length, done: 0, started: performance.now(), stop: false }
      window.addEventListener('beforeunload', beforeUnload)
      for (const f of items) { selected.delete(f.key); status.delete(f.key) }
      renderResults()
      const firstRow = root.querySelector(`#rows tr[data-k="${CSS.escape(items[0].key)}"]`); if (firstRow) firstRow.scrollIntoView({ block: 'nearest' })
      let results = []
      const runRows = [], when = new Date().toISOString()
      const logRow = (r) => [r.outcome, r.f.type, r.f.display, r.f.schema, r.f.tableLabel, r.f.solutions, r.f.id, r.detail, JSON.stringify(r.layers), when].map(csvCell).join(',')
      try {
        results = await removeLayers(items, (f, state, detail, r) => {
          if (state === 'Deleting') {
            status.set(f.key, { state }); deleting.current = `${f.display || f.schema} (${f.type})`
            updateRow(f)
            const tr = root.querySelector(`#rows tr[data-k="${CSS.escape(f.key)}"]`)
            if (tr && !app.hidden) tr.scrollIntoView({ block: 'nearest' })   // the list follows the one being deleted
            syncSelection()
            return
          }
          else {
            deleting.done++
            if (r) { const row = logRow(r); runRows.push(row); logRows.push(row); lastLog = logText(logRows) }   // kept at once
            layerEpoch++
            for (const p of places(f)) layerCache.delete(`${p.id}|${p.kind}`)   // the details read them again
            if (state === 'Deleted') { status.delete(f.key); f.deleted = true; keepDeleted.add(f.key) } else status.set(f.key, { state, detail })
            if (/does not allow deleting the unmanaged layer/.test(detail || '')) undeletable.add(f.code)   // no tick box for this type from now on
          }
          updateRow(f); syncSelection()
        }, { shouldStop: () => !!(deleting && deleting.stop) })
      } catch (e) { toast(`Stopped: ${e.message}`, { kind: 'warn', sticky: true }) }
      finally { deleting = null; window.removeEventListener('beforeunload', beforeUnload); syncMini() }
      for (const f of items) if ((status.get(f.key) || {}).state === 'Deleting') status.set(f.key, { state: 'Unknown', detail: 'not finished' })
      const rows = runRows
      lastLog = logRows.length ? logText(logRows) : null
      const runLog = logText(rows)   // this message downloads this run's log, whatever happens later
      for (const r of results) if (r && r.detail === 'you stopped the run') selected.add(r.f.key)   // still ticked: one click to go on
      const count = (o) => results.filter((r) => r && r.outcome === o).length
      const ok = count('Deleted'), unchecked = count('Deleted, not verified'), gone = count('Skipped'), skipped = results.userStopped || 0, partly = count('Partly deleted'), unknown = count('Unknown')
      const notOk = results.length - ok - unchecked - gone - skipped - partly - unknown
      const log = rows.length ? { label: 'Download log', run: () => download(`unmanaged-layers-deleted-${ORG}-${stamp()}.csv`, runLog, 'text/csv') } : null
      const nm = (f) => f.display || f.schema, away = app.hidden || host.style.display === 'none'
      const parts = [`${ok} deleted`, unchecked && `${unchecked} deleted but not checked`, gone && `${gone} already without an unmanaged layer`, partly && `${partly} partly deleted`, unknown && `${unknown} with an unknown result`, notOk && `${notOk} couldn't be deleted`, skipped && `${skipped} not tried`].filter(Boolean).join(', ') + (notOk || partly || unknown ? ' (the reasons are in the rows)' : '')
      if (results.stopped) toast(`Deleted ${ok}. Your sign-in expired, so the rest weren't tried. Reload the page and scan again.`, { kind: 'warn', action: log, sticky: true })
      else if (skipped) toast(`Stopped: ${parts}. The ones not tried are still ticked.`, { kind: 'warn', action: log, sticky: true })
      else if (ok === results.length && ok) toast(ok === 1 ? `Deleted the unmanaged layer of “${nm(results[0].f)}”.` : `Deleted ${ok} unmanaged layers.`, { action: log, sticky: away })
      else if (results.length) toast(`Done: ${parts}.`, { kind: notOk || unchecked || partly || unknown ? 'warn' : 'ok', action: log, sticky: true })
      renderResults()
      announce(`Deleted ${ok} of ${results.length}.`)
      setTimeout(() => $('resTitle').focus(), 0)
    })
  }

  // ---- the window: moved by its title bar, resized by its edges and corners, maximized with the button or a
  // double-click on the title bar. Its place and size are remembered in this browser. It floats over the page, so the
  // page stays usable around it.
  const win = $('win'), GEO = 'unmanagedLayerScanner:window', MIN_W = 720, MIN_H = 560
  const vw = () => document.documentElement.clientWidth || innerWidth, vh = () => document.documentElement.clientHeight || innerHeight
  // Kept inside the page: wholly when it fits (strict), or with at least part of the title bar reachable while moving.
  function fitGeo(g, strict) {
    const W = vw(), H = vh()
    const w = Math.round(Math.min(Math.max(g.w, Math.min(MIN_W, W)), W)), h = Math.round(Math.min(Math.max(g.h, Math.min(MIN_H, H)), H))
    const x = strict ? Math.min(Math.max(g.x, 0), W - w) : Math.min(Math.max(g.x, 160 - w), W - 160)
    const y = strict ? Math.min(Math.max(g.y, 0), H - h) : Math.min(Math.max(g.y, 0), H - 56)
    return { x: Math.round(x), y: Math.round(y), w, h, max: !!g.max }
  }
  const defaultGeo = () => { const W = vw(), H = vh(), w = Math.min(1280, W - 48), h = Math.min(900, H - 48); return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h, max: false } }
  let geo = null
  try { const g = JSON.parse(localStorage.getItem(GEO) || 'null'); if (g && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(g[k]))) geo = fitGeo(g, true) } catch { }
  if (!geo) geo = fitGeo(defaultGeo(), true)
  const saveGeo = () => { try { localStorage.setItem(GEO, JSON.stringify(geo)) } catch { } }
  function placeWin() {
    win.classList.toggle('max', geo.max)
    const b = $('maxBtn'), t = geo.max ? 'Restore down' : 'Maximize'
    b.innerHTML = icon(geo.max ? 'restore' : 'maximize', 20); b.title = t; b.setAttribute('aria-label', t)
    Object.assign(win.style, { left: geo.x + 'px', top: geo.y + 'px', width: geo.w + 'px', height: geo.h + 'px' })
    placePop()
  }
  placeWin()
  const toggleMax = () => { geo = geo.max ? fitGeo({ ...geo, max: false }, true) : { ...geo, max: true }; placeWin(); saveGeo() }
  $('maxBtn').onclick = toggleMax
  let drag = null
  function startDrag(e, mode) {
    if (e.button !== 0 || drag) return
    e.preventDefault()
    drag = { mode, sx: e.clientX, sy: e.clientY, g: { ...geo }, id: e.pointerId, moved: false }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
    app.classList.add(mode === 'move' ? 'moving' : 'sizing')
    app.style.cursor = mode === 'move' ? 'move' : getComputedStyle(e.currentTarget).cursor
    closePop(); closeMenus()
  }
  function onDrag(e) {
    if (!drag || e.pointerId !== drag.id) return
    if (!drag.moved) {   // a click is not a move
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return
      drag.moved = true
      if (drag.mode === 'move' && geo.max) {   // a maximized window comes back to its size under the pointer, as in Windows
        geo = fitGeo({ ...geo, max: false, x: drag.sx - (drag.sx / Math.max(1, vw())) * geo.w, y: 0 })
        drag.g = { ...geo }
        placeWin()
      }
    }
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy, o = drag.g, W = vw(), H = vh(), d = drag.mode
    if (d === 'move') { geo = fitGeo({ ...o, x: o.x + dx, y: o.y + dy }); placeWin(); return }
    const g = { ...o }, minW = Math.min(MIN_W, W), minH = Math.min(MIN_H, H)
    if (d.includes('e')) g.w = Math.max(minW, Math.min(o.w + dx, W - o.x))
    if (d.includes('s')) g.h = Math.max(minH, Math.min(o.h + dy, H - o.y))
    if (d.includes('w')) { const x = Math.max(Math.min(0, o.x), Math.min(o.x + dx, o.x + o.w - minW)); g.w = o.w + o.x - x; g.x = x }
    if (d.includes('n')) { const y = Math.max(0, Math.min(o.y + dy, o.y + o.h - minH)); g.h = o.h + o.y - y; g.y = y }
    geo = { ...g, max: false }
    placeWin()
  }
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return
    const moved = drag.moved
    drag = null
    app.classList.remove('moving', 'sizing'); app.style.cursor = ''
    if (moved) saveGeo()
  }
  $('top').addEventListener('pointerdown', (e) => { if (!e.target.closest('button,a,input')) startDrag(e, 'move') })
  $('top').addEventListener('dblclick', (e) => { if (!e.target.closest('button,a,input')) toggleMax() })
  for (const h of root.querySelectorAll('.rz')) h.addEventListener('pointerdown', (e) => startDrag(e, h.dataset.d))
  win.addEventListener('pointermove', onDrag)
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) win.addEventListener(ev, endDrag)
  const onResize = () => { if (!geo.max) { geo = fitGeo(geo, true); placeWin() } else placePop() }
  window.addEventListener('resize', onResize)

  // ---- open, close, environment changes
  const minimize = () => { app.hidden = true; mini.hidden = false; syncMini() }
  const restore = () => { app.hidden = false; mini.hidden = true }
  const hide = () => {
    if (dlgClose && !deleting) { dlgClose(); return }
    closeMenus(); closePop()
    if (deleting) { minimize(); return }   // deleting goes on; the pill in the corner shows how far it is
    restore(); host.style.display = 'none'
  }
  $('close').onclick = hide
  // Escape works on the window only when it has the focus (the page around it keeps its own Escape).
  const onEscape = (e) => {
    if (e.key !== 'Escape' || host.style.display === 'none' || app.hidden || !e.composedPath().includes(host)) return
    e.preventDefault()
    const t = e.composedPath()[0]
    if (t && t.type === 'search' && t.value) { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return }   // first Escape clears a search
    if (!$('pop').hidden) { closePop(true); return }
    if (!$('savedMenu').hidden || !$('exportMenu').hidden || !$('moreMenu').hidden) { closeMenus(true); return }
    if (!dlgClose && !$('sheet').hidden) { closeSheet(); return }
    hide()
  }
  document.addEventListener('keydown', onEscape, true)
  // Tab stays inside the window (inside the dialog while one is open).
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return
    const scope = !$('dlg').hidden ? $('dlg') : root.querySelector('.panel')
    const f = [...scope.querySelectorAll('button,input,select,a[href],[tabindex="0"],summary')].filter((x) => !x.disabled && x.offsetParent !== null && !x.closest('[inert]'))
    if (!f.length) return
    const i = f.indexOf(root.activeElement)
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus() } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus() }
  })
  // The managed solution open in the maker portal (its page address), if any.
  const openSolution = () => {
    const id = ON_MAKER ? lc((/\/solutions\/([0-9a-f-]{36})/i.exec(location.pathname) || [])[1]) : ''
    return id ? allSolutions.find((x) => x.id === id) || { notManaged: true } : null
  }
  const takeOpenSolution = () => {
    const s = openSolution()
    if (s && !s.notManaged) { chosen = new Set([s.unique]); typesSel = new Set(GROUPS); tablesSel = new Set(); activeSaved = ''; pickReason = "selected because it's open in the maker portal"; return true }
    if (s) { pickReason = "The solution open in the maker portal isn't managed. Select managed solutions to scan." ; return true }
    return false
  }
  const show = () => {
    host.style.display = ''
    restore()
    onResize()   // the page may have been resized while the window was closed
    if (busy || solState !== 'ready' || dlgClose) return
    const s = openSolution()
    if (s && !s.notManaged && !(chosen.size === 1 && chosen.has(s.unique))) { takeOpenSolution(); setView('pick') }
    else if (view === 'pick') renderPick()
  }
  // Removes the window (when the maker portal has moved to another environment). Not while working.
  const destroy = () => { if (busy) return false; document.removeEventListener('keydown', onEscape, true); window.removeEventListener('resize', onResize); host.remove(); delete window.__layerScanner; return true }
  window.__layerScanner = { key: KEY, version: VERSION, show, destroy, ready: () => solState === 'ready', scan, listManagedSolutions, loadDetails, removeLayers, getLayers, layersUrl, config: CONFIG, environment: () => ({ org: ORG, url: ORIGIN, envId: conn.envId }),
    parts: { diffLines, prettyXml, indentJson, parseJson, valueView, childTables, scalarText } }   // also used by automated tests
  // Read the managed solutions and show them.
  function loadSolutions() {
    solState = 'loading'; solError = ''; renderSolutions(); renderPickBar()
    withBusy(async () => {
      try {
        allSolutions = await listManagedSolutions()
        const known = new Set(allSolutions.map((s) => s.unique))
        chosen = new Set([...chosen].filter((u) => known.has(u)))
        // The environment id, for the links to the maker portal (the maker portal's own address already has it).
        if (!conn.envId) try { conn.envId = lc((await read("RetrieveCurrentOrganization(AccessType=Microsoft.Dynamics.CRM.EndpointAccessType'Default')")).Detail.EnvironmentId) } catch (e) { if (e instanceof SessionError) throw e }
        takeOpenSolution()   // started from a solution's page in the maker portal: that solution, all types
        solState = allSolutions.length ? 'ready' : 'none'
      } catch (e) { solState = 'failed'; solError = e.message }
    }).then(() => {
      if (view === 'pick') renderPick()
      if (solState === 'ready') loadTables().catch(() => { })   // the tables' display names, for the Tables card; read again when chosen
    })
  }
  setView('pick')
  loadSolutions()
})()
