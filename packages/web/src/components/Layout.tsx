import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { Avatar, Button } from "./ui";
import "./layout.css";

/** The app shell: a header, the routed page, and a footer. */
export function Layout() {
  const { status, user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <>
      {/* First tab stop on every page, so keyboard users can jump the nav. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="header">
        <div className="header__inner">
          <Link to="/" className="brand" aria-label="Tessera home">
            <Mosaic />
            <span>Tessera</span>
          </Link>

          <nav className="header__nav" aria-label="Main">
            <NavLink to="/" end className={navClass}>
              Explore
            </NavLink>
            {status === "authenticated" && user && (
              <NavLink to={`/${user.username}`} className={navClass}>
                Your work
              </NavLink>
            )}
          </nav>

          <div className="row header__actions">
            <ThemeToggle />

            {status === "loading" && <span className="spinner" aria-label="Loading session" />}

            {status === "anonymous" && (
              <>
                <Link to="/login" className="button button--ghost">
                  Sign in
                </Link>
                <Link to="/signup" className="button button--primary">
                  Sign up
                </Link>
              </>
            )}

            {status === "authenticated" && user && (
              <>
                <Link to="/new" className="button button--primary">
                  New
                </Link>
                <Link to={`/${user.username}`} className="header__me" title={user.username}>
                  <Avatar user={user} size={30} />
                </Link>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await signOut();
                    navigate("/");
                  }}
                >
                  Sign out
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="main">
        <Outlet />
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <span className="subtle">
            Tessera — content-addressed version control, built from first principles.
          </span>
        </div>
      </footer>
    </>
  );
}

const navClass = ({ isActive }: { isActive: boolean }) => `header__link${isActive ? " is-active" : ""}`;

/** The mark: four tiles, because a tessera is a mosaic tile. */
function Mosaic() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="0" y="0" width="9" height="9" rx="2" fill="currentColor" />
      <rect x="11" y="0" width="9" height="9" rx="2" fill="currentColor" opacity="0.55" />
      <rect x="0" y="11" width="9" height="9" rx="2" fill="currentColor" opacity="0.55" />
      <rect x="11" y="11" width="9" height="9" rx="2" fill="currentColor" opacity="0.25" />
    </svg>
  );
}

type Theme = "light" | "dark";

/**
 * Light/dark toggle.
 *
 * The choice is stored, but nothing is written until the user actually picks
 * one - until then the app follows the system preference, which is what the
 * CSS does by default.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(() => {
    const stored = localStorage.getItem("tessera-theme");
    return stored === "light" || stored === "dark" ? stored : null;
  });

  useEffect(() => {
    if (theme) {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("tessera-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [theme]);

  const resolved: Theme =
    theme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  return (
    <button
      className="button button--ghost"
      onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
      aria-label={`Switch to ${resolved === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${resolved === "dark" ? "light" : "dark"} theme`}
    >
      {resolved === "dark" ? "☀" : "☾"}
    </button>
  );
}
