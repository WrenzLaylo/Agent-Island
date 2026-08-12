import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The `island` wrapper. Built alongside main because it shares the
          // agent detectors and must run against Electron's node ABI (node-pty
          // is rebuilt for Electron), so it is launched via
          // ELECTRON_RUN_AS_NODE rather than a separate node install.
          wrapper: resolve('src/wrapper/index.ts'),
          // The Claude Code PreToolUse hook. Built here so it can share the
          // protocol module, and unpacked from the asar like the wrapper --
          // Claude spawns it with plain node, which cannot read an archive.
          'claude-hook': resolve('src/hooks/claude-hook.ts'),
          'codex-hook': resolve('src/hooks/codex-hook.ts'),
          'claude-session-hook': resolve('src/hooks/claude-session-hook.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html')
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    }
  }
})
