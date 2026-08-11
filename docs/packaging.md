# Packaging

```sh
npm run package        # build + NSIS installer + portable exe -> release/
npm run package:dir    # build + unpacked directory only, for testing
npm run icon           # regenerate build/icon.ico
```

Output lands in `release/` (git-ignored):

| Artifact | Size | Use |
|---|---|---|
| `Agent Island Setup 0.4.0.exe` | ~96 MB | NSIS installer, per-user, choosable directory |
| `Agent Island 0.4.0.exe` | ~96 MB | Portable, runs without installing |
| `win-unpacked/` | ~339 MB | Expanded app, what the two above contain |

## The parts that are not obvious

### The wrapper must live outside the asar

`island.cmd` prefers plain `node` over Electron, deliberately: Electron is a
GUI-subsystem binary, so under `ELECTRON_RUN_AS_NODE` its stdio is never a
console — `stdin.isTTY` is false, raw mode cannot be set, and VT sequences are
printed literally. The agent is unusable that way.

But node knows nothing about asar. If the wrapper only existed inside the
archive, node would report it missing, the shim would fail open to the bare
agent, and the user would silently lose every feature this app provides while
everything appeared to work.

So `asarUnpack` keeps `out/main/**` on disk, and `wrapperPath()` in
`src/main/agents/shell-shims.ts` rewrites `app.asar` to `app.asar.unpacked`
when that copy exists.

**The whole directory, not just `wrapper.js`.** The build is code-split, and
unpacking only the entry point produced a wrapper that existed but could not
start:

```
Error: Cannot find module './chunks/contracts-DgBKl0PI.js'
```

That is the worst possible shape of failure here — the shim's existence check
passes, so it believes the install is fine. Listing the directory also means a
future chunk cannot reintroduce it.

### Native modules

`node-pty` is unpacked for the ordinary reason: Windows cannot load a `.node`
from inside an archive.

`npmRebuild: false` is set. node-pty ships prebuilt binaries and both runtimes
that matter already load them unrebuilt — the Electron app and the plain-node
wrapper. Leaving the rebuild on requires a full Visual Studio toolchain on
every machine that packages this, to produce a binary that is already there.
Without it the build fails with `Could not find any Visual Studio installation
to use`.

### Signing

Driven by environment variables, never by a path in the config:

```sh
CSC_LINK=build/dev-cert.pfx
CSC_KEY_PASSWORD=…
npm run package
```

With them unset the build is unsigned and succeeds. Naming a certificate file
in `electron-builder.yml` would make the build *fail* for anyone without that
file, including a fresh clone.

Note that electron-builder logs `signing with signtool.exe` during the
resource-edit step whether or not a certificate is configured. It is not
evidence of a signature. Check properly:

```powershell
Get-AuthenticodeSignature 'release\win-unpacked\Agent Island.exe' | Select Status
```

#### Self-signed, for your own machines

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-dev-cert.ps1
```

It writes `build/dev-cert.pfx` (git-ignored) and prints the one command you
must run yourself, elevated, to trust it. **Until the certificate is in
`LocalMachine\Root`, signed builds still warn — including on the machine that
made them.**

Trusting it makes that machine accept any binary signed with that key, so the
`.pfx` is a credential. This does nothing for anyone else's machine.

#### Distributing to other people

Since June 2023, CA/Browser Forum rules require code-signing keys to sit on
FIPS 140-2 Level 2 hardware — a USB token or a cloud HSM. Buying a certificate
and dropping a `.pfx` into CI is no longer possible; guides that describe it
predate the change.

| Route | Cost | Notes |
|---|---|---|
| Azure Trusted Signing | ~$10/mo | Cloud, no token, `win.azureSignOptions` |
| OV certificate | ~$200–400/yr | Hardware token; awkward to automate |
| EV certificate | ~$400–700/yr | The only route with immediate SmartScreen reputation |

Signing and reputation are separate. An OV certificate removes "unknown
publisher", but a new installer still starts with no SmartScreen reputation
and can keep warning until downloads accumulate. Only EV avoids that on day
one.

### Start at login

Owned by the app (`src/main/login-item.ts`), not by the installer. An
installer checkbox would write a second registry entry that the tray toggle
could not see or report on, which is precisely the bug fixed in `dc2be5e`.

A packaged build also gets a real AppUserModelId, so its login entry is named
properly instead of sharing the generic `electron.app.Electron` value that an
unpackaged run is stuck with.

### userData

`app.getName()` resolves from `package.json` `name` (`agent-island`), not from
`productName` in the builder config, so a packaged build reads the same
settings as a dev run. The session registry under `%LOCALAPPDATA%/agent-island`
is shared regardless.

One consequence worth knowing: launching a packaged build rewrites
`%APPDATA%/agent-island/bin/island.cmd` to point into its own install. Running
the dev app again rewrites it back. That is by design — the launchers are
regenerated on every start so they follow the app — but two installations do
compete for that file.
