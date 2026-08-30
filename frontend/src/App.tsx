import { RouterProvider } from 'react-router-dom'
import { router } from '@/routers'

export function App() {
  return <RouterProvider router={router} />
}