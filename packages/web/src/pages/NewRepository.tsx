import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { ApiError, api } from "../lib/api";
import type { Repository } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Alert, Button, Field, Spinner, TextArea } from "../components/ui";

export function NewRepositoryPage() {
  const { status, user } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"PUBLIC" | "PRIVATE">("PUBLIC");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Waiting for the session check - not the same as being signed out, so this
  // must not redirect yet.
  if (status === "loading") return <Spinner label="Checking your session" />;
  if (status === "anonymous") return <Navigate to="/login" replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const { repository } = await api.post<{ repository: Repository }>("/repositories", {
        name,
        ...(description ? { description } : {}),
        visibility,
      });
      navigate(`/${user?.username}/${repository.name}`);
    } catch (error) {
      if (error instanceof ApiError) {
        const fields = error.fieldErrors;
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        else setFormError(error.message);
      } else {
        setFormError("Could not create the repository.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page page--narrow stack stack--loose">
      <div className="stack stack--tight">
        <h1>New repository</h1>
        <p className="muted">A place to keep a project and its history.</p>
      </div>

      {formError && <Alert>{formError}</Alert>}

      <form className="card stack" onSubmit={handleSubmit} noValidate>
        <Field
          label="Repository name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldErrors.name}
          hint={
            name
              ? `Will live at /${user?.username}/${name}`
              : "Letters, numbers, dots, hyphens and underscores."
          }
          placeholder="my-project"
          autoFocus
          required
        />

        <TextArea
          label="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          error={fieldErrors.description}
          hint="Optional. One line about what this is."
          rows={3}
        />

        <fieldset className="stack stack--tight" style={{ border: 0 }}>
          <legend className="field__label">Visibility</legend>

          <label className="row" style={{ alignItems: "flex-start" }}>
            <input
              type="radio"
              name="visibility"
              checked={visibility === "PUBLIC"}
              onChange={() => setVisibility("PUBLIC")}
              style={{ marginTop: "0.3rem" }}
            />
            <span>
              <span className="strong">Public</span>
              <br />
              <span className="subtle">Anyone can see this repository.</span>
            </span>
          </label>

          <label className="row" style={{ alignItems: "flex-start" }}>
            <input
              type="radio"
              name="visibility"
              checked={visibility === "PRIVATE"}
              onChange={() => setVisibility("PRIVATE")}
              style={{ marginTop: "0.3rem" }}
            />
            <span>
              <span className="strong">Private</span>
              <br />
              <span className="subtle">Only you can see it. It stays out of search and listings.</span>
            </span>
          </label>
        </fieldset>

        <div className="row">
          <Button type="submit" variant="primary" loading={submitting} disabled={!name.trim()}>
            Create repository
          </Button>
          <Button type="button" variant="ghost" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
