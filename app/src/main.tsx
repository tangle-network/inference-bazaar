import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import 'virtual:uno.css'
import './styles.css'
import { Web3Provider } from '~/providers/web3'
import { Shell } from '~/components/Shell'
import { RouteError } from '~/components/RouteError'
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

// Every route degrades to RouteError on a render/loader throw rather than
// white-screening the app.
function route(path: string, node: React.ReactNode) {
  return { path, element: withShell(node), errorElement: withShell(<RouteError />) }
}

const router = createBrowserRouter([
  route('/', <HomePage />),
  route('/markets', <MarketsPage />),
  // Model ids contain a slash (e.g. anthropic/claude-opus-4-8) — match the rest.
  route('/m/*', <ModelMarketPage />),
  route('/buy', <BuyPage />),
  route('/buy/*', <BuyPage />),
  route('/sell', <SellPage />),
  route('/operators', <OperatorsPage />),
  route('/operators/register', <OperatorRegisterPage />),
  route('/activity', <ActivityPage />),
  route('/portfolio', <PortfolioPage />),
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Web3Provider>
      <RouterProvider router={router} />
    </Web3Provider>
  </StrictMode>,
)
