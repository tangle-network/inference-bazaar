import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import 'virtual:uno.css'
import './styles.css'
import { Web3Provider } from '~/providers/web3'
import { Shell } from '~/components/Shell'
import HomePage from '~/pages/Home'
import MarketsPage from '~/pages/Markets'
import ModelMarketPage from '~/pages/ModelMarket'
import BuyPage from '~/pages/Buy'
import SellPage from '~/pages/Sell'
import OperatorsPage from '~/pages/Operators'
import OperatorRegisterPage from '~/pages/OperatorRegister'
import ActivityPage from '~/pages/Activity'
import PortfolioPage from '~/pages/Portfolio'

function withShell(node: React.ReactNode) {
  return <Shell>{node}</Shell>
}

const router = createBrowserRouter([
  { path: '/', element: withShell(<HomePage />) },
  { path: '/markets', element: withShell(<MarketsPage />) },
  // Model ids contain a slash (e.g. anthropic/claude-opus-4-8) — match the rest.
  { path: '/m/*', element: withShell(<ModelMarketPage />) },
  { path: '/buy', element: withShell(<BuyPage />) },
  { path: '/buy/*', element: withShell(<BuyPage />) },
  { path: '/sell', element: withShell(<SellPage />) },
  { path: '/operators', element: withShell(<OperatorsPage />) },
  { path: '/operators/register', element: withShell(<OperatorRegisterPage />) },
  { path: '/activity', element: withShell(<ActivityPage />) },
  { path: '/portfolio', element: withShell(<PortfolioPage />) },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Web3Provider>
      <RouterProvider router={router} />
    </Web3Provider>
  </StrictMode>,
)
