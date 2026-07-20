import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Link } from "react-router-dom";

import { Layout } from "./components/Layout";
import { EmptyState } from "./components/ui";
import { AuthProvider } from "./lib/auth";
import { AuthPage } from "./pages/Auth";
import { ExplorePage } from "./pages/Explore";
import { NewRepositoryPage } from "./pages/NewRepository";
import { ProfilePage } from "./pages/Profile";
import { RepositoryPage } from "./pages/RepositoryPage";

/**
 * Routing.
 *
 * The `/:username` and `/:username/:name` routes come last on purpose. React
 * Router ranks static segments above dynamic ones, but keeping the order
 * explicit makes it obvious that `/new` is a page and not somebody's profile.
 */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<ExplorePage />} />
            <Route path="login" element={<AuthPage mode="login" />} />
            <Route path="signup" element={<AuthPage mode="signup" />} />
            <Route path="new" element={<NewRepositoryPage />} />

            <Route path=":username" element={<ProfilePage />} />
            <Route path=":username/:name" element={<RepositoryPage />} />

            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

function NotFound() {
  return (
    <div className="page">
      <EmptyState
        title="Page not found"
        action={
          <Link to="/" className="button button--primary">
            Back to explore
          </Link>
        }
      >
        That address does not lead anywhere.
      </EmptyState>
    </div>
  );
}
