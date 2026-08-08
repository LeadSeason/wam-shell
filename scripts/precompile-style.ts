// Headless stylesheet build, run by `wam install` and `wam update`.
//
// The shell's cold-start path compiles sass SYNCHRONOUSLY when there is
// no cached css at all — it has to, because ags loads the stylesheet at
// activation and an async compile races the first frame. That block is
// the slowest thing in startup, and it is entirely avoidable: the only
// times the cache is genuinely cold are install, update --force and a
// cache wipe, and the first two are moments where we are already
// running a build step.
//
// So: same code the shell uses (lib/styleCompile, which is display-free
// for exactly this reason), run once at install time. No duplicated
// theme resolution in bash, no second definition of the load paths.
//
// Bundled with `ags bundle` — see compile_style() in scripts/wam.

import Config from "../src/config"
import { compileSync, planCompile } from "../src/lib/styleCompile"

const { needed } = planCompile()
if (!needed) {
    print(`style: ${Config.cssPath} is already up to date`)
} else if (compileSync()) {
    print(`style: compiled ${Config.cssPath}`)
} else {
    // not fatal to the install: the shell still compiles on first run,
    // it just pays for it there
    printerr("style: precompile failed; the shell will compile on first start")
}
