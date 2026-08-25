import { RouterProvider } from 'react-router-dom'
import { router } from '@/routers'

export default function App() {
  return <RouterProvider router={router} />
}