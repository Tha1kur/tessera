import { useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";

import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Alert, Button, Field } from "../components/ui";

/**
 * Sign in and sign up.
 *
 * One component for both because the layout and error handling are identical;
 * only the fields and the call differ. Splitting them would duplicate the
 * interesting part - which is the error handling - in two places.
 */
export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { status, signIn, signUp } = useAuth();
  const navigate = useNavigate();

  const [values, setValues] = useState({ username: "", email: "", password: "", displayName: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in? There is nothing to do here.
  if (status === "authenticated") return <Navigate to="/" replace />;

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      if (mode === "login") {
        await signIn(values.email, values.password);
      } else {
        await signUp({
          username: values.username,
          email: values.email,
          password: values.password,
          ...(values.displayName ? { displayName: values.displayName } : {}),
        });
      }
      navigate("/");
    } catch (error) {
      if (error instanceof ApiError) {
        // The API reports which field was wrong, so the message goes next to
        // that field rather than into a vague banner at the top.
        const fields = error.fieldErrors;
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        else setFormError(error.message);
      } else {
        setFormError("Could not reach the server. Is the API running?");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const isSignup = mode === "signup";

  return (
    <div className="page page--narrow">
      <div className="card stack">
        <div className="stack stack--tight">
          <h1>{isSignup ? "Create your account" : "Welcome back"}</h1>
          <p className="muted">
            {isSignup ? "Start tracking your work with Tessera." : "Sign in to continue."}
          </p>
        </div>

        {formError && <Alert>{formError}</Alert>}

        <form className="stack" onSubmit={handleSubmit} noValidate>
          {isSignup && (
            <>
              <Field
                label="Username"
                value={values.username}
                onChange={set("username")}
                error={fieldErrors.username}
                hint="Letters, numbers and single hyphens."
                autoComplete="username"
                required
              />
              <Field
                label="Display name"
                value={values.displayName}
                onChange={set("displayName")}
                error={fieldErrors.displayName}
                hint="Optional."
                autoComplete="name"
              />
            </>
          )}

          <Field
            label="Email"
            type="email"
            value={values.email}
            onChange={set("email")}
            error={fieldErrors.email}
            autoComplete="email"
            required
          />

          <Field
            label="Password"
            type="password"
            value={values.password}
            onChange={set("password")}
            error={fieldErrors.password}
            {...(isSignup ? { hint: "At least 10 characters. Length beats symbols." } : {})}
            // Tells a password manager whether to offer a saved password or
            // suggest a new one.
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
          />

          <Button type="submit" variant="primary" large block loading={submitting}>
            {isSignup ? "Create account" : "Sign in"}
          </Button>
        </form>

        <hr className="divider" />

        <p className="subtle" style={{ textAlign: "center" }}>
          {isSignup ? (
            <>
              Already have an account? <Link to="/login">Sign in</Link>
            </>
          ) : (
            <>
              New here? <Link to="/signup">Create an account</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
