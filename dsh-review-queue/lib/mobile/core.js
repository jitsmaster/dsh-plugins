/**
 * The card helpers shared with the desktop overlay. The overlay bundle (lib/client.js, served here as overlay.js) is a DSH client
 * module; it is loaded with a stub React and only its pure helpers (exports.shared) are used, so the logic and its tests exist once.
 */
const STUB_REACT = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }

export function loadCore() {
  return new Promise((resolve, reject) => {
    let registered
    window.__ModuleLoader__ = { load: (r) => { registered = r } }
    const script = document.createElement('script')
    script.src = './overlay.js'
    script.onload = () => {
      try {
        const mod = registered.factory(() => STUB_REACT)
        if (!mod || !mod.shared) throw new Error('overlay.js has no shared helpers (is the server older than this page?)')
        resolve(mod.shared)
      } catch (error) { reject(error) } finally { delete window.__ModuleLoader__ }
    }
    script.onerror = () => reject(new Error('overlay.js could not be loaded'))
    document.head.append(script)
  })
}
