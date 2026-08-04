import Gio from "gi://Gio?version=2.0"

// Soft Secret Service (libsecret) backend for wam-shell secrets — a
// runtime-OPTIONAL dependency in both senses: the gi://Secret typelib
// may not be installed, and the org.freedesktop.secrets D-Bus service
// may not exist (minimal sessions, containers). Both are resolved
// lazily on first use inside try/catch; any failure just means
// "unavailable" and callers fall back to their 0600 file. No
// Gjs-CRITICAL on machines without either.
//
// Two deliberate choices:
// - the gjs bindings are used with the CALLBACK form wrapped in
//   Promises: gjs does not auto-promisify libsecret's password_*
//   functions (it demands the callback argument), whatever the
//   generated .d.ts overloads suggest. The alternative — secret-tool —
//   was rejected: the secret would have to travel over stdin, which
//   the metrics exec wrappers cannot do (and argv would leak it into
//   the process list).
// - one schema for every entry: attributes app=wam-shell,
//   service=<provider id>, account=<identity label>. The stored value
//   is the token itself — never log it.

type SecretMod = typeof import("gi://Secret?version=1").default
type Schema = InstanceType<SecretMod["Schema"]>

const APP = "wam-shell"
const SCHEMA_NAME = "org.wamshell.OAuth"

let mod: SecretMod | null = null
let schema: Schema | null = null
let probing: Promise<boolean> | null = null

function lookupRaw(attributes: Record<string, string>): Promise<string | null> {
    return new Promise((resolve, reject) => {
        mod!.password_lookup(schema!, attributes, null, (_s: unknown, res: Gio.AsyncResult) => {
            try {
                resolve(mod!.password_lookup_finish(res) ?? null)
            } catch (e) {
                reject(e)
            }
        })
    })
}

// resolve the typelib AND the service once; the result is cached for
// the session (a keyring that appears later is picked up at the next
// shell start — load/store callers re-probe through this same promise)
export function secretsAvailable(): Promise<boolean> {
    if (!probing) {
        probing = (async () => {
            try {
                mod = (await import("gi://Secret?version=1")).default
                schema = mod.Schema.new(SCHEMA_NAME, mod.SchemaFlags.NONE, {
                    app: mod.SchemaAttributeType.STRING,
                    service: mod.SchemaAttributeType.STRING,
                    account: mod.SchemaAttributeType.STRING,
                })
                // an installed typelib says nothing about the service:
                // probe it with a harmless lookup for a nonexistent key
                await lookupRaw({ app: APP, service: "probe", account: "probe" })
                return true
            } catch {
                mod = null
                schema = null
                return false
            }
        })()
    }
    return probing
}

// false when the keyring is unavailable or the write failed (caller
// keeps the file copy in that case)
export async function secretStore(
    service: string,
    account: string,
    token: string,
): Promise<boolean> {
    if (!(await secretsAvailable())) return false
    try {
        return await new Promise<boolean>((resolve, reject) => {
            mod!.password_store(
                schema!,
                { app: APP, service, account },
                mod!.COLLECTION_DEFAULT,
                `wam-shell ${service} sign-in (${account})`,
                token,
                null,
                (_s: unknown, res: Gio.AsyncResult) => {
                    try {
                        resolve(mod!.password_store_finish(res))
                    } catch (e) {
                        reject(e)
                    }
                },
            )
        })
    } catch (e) {
        console.warn(`secretStore: could not store the ${service} token:`, e)
        return false
    }
}

export async function secretLookup(service: string, account: string): Promise<string | null> {
    if (!(await secretsAvailable())) return null
    try {
        return await lookupRaw({ app: APP, service, account })
    } catch {
        return null
    }
}

export async function secretClear(service: string, account: string): Promise<void> {
    if (!(await secretsAvailable())) return
    try {
        await new Promise<void>((resolve, reject) => {
            mod!.password_clear(
                schema!,
                { app: APP, service, account },
                null,
                (_s: unknown, res: Gio.AsyncResult) => {
                    try {
                        mod!.password_clear_finish(res)
                        resolve()
                    } catch (e) {
                        reject(e)
                    }
                },
            )
        })
    } catch {}
}
