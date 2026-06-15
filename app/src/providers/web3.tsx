/**
 * Real wallet wiring — the arena pattern: wagmi config via ConnectKit's
 * getDefaultConfig, wrapped in blueprint-ui's Web3Shell (query client +
 * wagmi provider) and ConnectKitProvider. Chains: Base Sepolia first (where
 * the InferenceBazaar blueprint and settlement contracts live), then Tangle.
 */
import type { ReactNode } from 'react'
import { http } from 'wagmi'
import { createConfig } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import { ConnectKitProvider, getDefaultConfig } from 'connectkit'
import { defaultConnectKitOptions, tangleMainnet, tangleTestnet } from '@tangle-network/blueprint-ui'
import { Web3Shell } from '@tangle-network/blueprint-ui/components'

const chains = [baseSepolia, tangleTestnet, tangleMainnet] as const

const config = createConfig(
  getDefaultConfig({
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
  }),
)

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
