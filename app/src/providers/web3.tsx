/**
 * Real wallet wiring — the arena pattern: wagmi config via ConnectKit's
 * getDefaultConfig, wrapped in blueprint-ui's Web3Shell (query client +
 * wagmi provider) and ConnectKitProvider. Chains: Base Sepolia first (where
 * the InferenceBazaar blueprint and settlement contracts live), then Tangle.
 *
 * When embedded inside Tangle Cloud's iframe, the injected/WalletConnect
 * connectors are replaced with the parent-bridge connector so the wallet
 * flows from the parent dapp (browser extensions can't inject into the
 * sandboxed cross-origin iframe anyway). Standalone visits keep ConnectKit.
 */
import type { ReactNode } from 'react'
import { http } from 'wagmi'
import { createConfig } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import { ConnectKitProvider, getDefaultConfig } from 'connectkit'
import { defaultConnectKitOptions, tangleMainnet, tangleTestnet } from '@tangle-network/blueprint-ui'
import { Web3Shell } from '@tangle-network/blueprint-ui/components'
import {
  detectTangleCloudParentOrigin,
  parentBridgeConnector,
} from '@tangle-network/blueprint-ui/wallet'

const chains = [baseSepolia, tangleTestnet, tangleMainnet] as const

// Detect Tangle Cloud iframe context once at module load. The detection reads
// `document.referrer` + `window.location` — stable for the iframe's lifetime.
// Thread `VITE_TANGLE_CLOUD_ORIGINS` (comma-separated) into the library's
// origin allowlist; the library doesn't read `import.meta.env` itself so it
// stays bundler-agnostic.
const EXTRA_PARENT_ORIGINS = (
  import.meta.env.VITE_TANGLE_CLOUD_ORIGINS as string | undefined
)
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const PARENT_ORIGIN = detectTangleCloudParentOrigin({
  extraOrigins: EXTRA_PARENT_ORIGINS,
})
export const isEmbeddedInTangleCloud = PARENT_ORIGIN !== null

const baseDefaultConfig = getDefaultConfig({
  chains,
  transports: Object.fromEntries(
    chains.map((c) => [c.id, http(c.rpcUrls.default.http[0])]),
  ),
  walletConnectProjectId:
    import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '3fcc6bba6f1de962d911bb5b5c3dba68',
  appName: 'Inference Bazaar',
  appDescription: 'Open market for AI inference — prepaid inference-token credits.',
  appUrl: typeof window !== 'undefined' ? window.location.origin : 'https://inference-bazaar.blueprint.tangle.tools',
  appIcon: '/favicon.svg',
})

// When embedded by Tangle Cloud, replace the injected/WalletConnect/Coinbase
// connectors with the parent-bridge connector. Browser-extension and popup
// connectors don't work inside the sandboxed iframe (no window.ethereum
// injection, no popup permission), so surfacing them in ConnectKit's modal
// would only confuse operators. The bridge connector auto-connects via
// `isAuthorized() === true`, so the iframe inherits the parent dapp's
// wallet without a separate wallet picker.
const config =
  PARENT_ORIGIN !== null
    ? createConfig({
        ...baseDefaultConfig,
        connectors: [
          parentBridgeConnector({
            parentOrigin: PARENT_ORIGIN,
            appId: 'surplus',
          }),
        ],
      })
    : createConfig(baseDefaultConfig)

export function Web3Provider({ children }: { children: ReactNode }) {
  return (
    <Web3Shell config={config}>
      <ConnectKitProvider theme="auto" mode="auto" options={defaultConnectKitOptions}>
        {children}
      </ConnectKitProvider>
    </Web3Shell>
  )
}

export const INFERENCE_BAZAAR_CHAIN = baseSepolia

/** Chains InferenceBazaar runs on, for the network switcher. Only Base Sepolia is live
 * today; Base mainnet is listed (disabled) so the switcher is ready for the
 * mainnet cutover — flip `live`, add the chain to `chains` above, and wire its
 * contract addresses. */
export type InferenceBazaarChainInfo = { id: number; name: string; short: string; live: boolean }
export const INFERENCE_BAZAAR_CHAINS: InferenceBazaarChainInfo[] = [
  { id: baseSepolia.id, name: 'Base Sepolia', short: 'Base Sepolia', live: true },
  { id: 8453, name: 'Base', short: 'Base mainnet', live: false },
]
