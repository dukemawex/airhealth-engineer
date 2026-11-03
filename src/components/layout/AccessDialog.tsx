"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

/** Shown only when the deployment sets API_AUTH_TOKEN and a request returned 401. */
export function AccessDialog({ open, onSave, onClose }: { open: boolean; onSave: (token: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [token, setToken] = useState("");
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.trim()) onSave(token.trim());
  };
  return (
    <dialog ref={ref} className="modal" aria-labelledby="access-title" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <div className="modal-header">
          <div>
            <span className="kicker">Protected deployment</span>
            <h2 id="access-title">Access token required</h2>
          </div>
        </div>
        <p className="card-sub">This deployment is protected. Paste the access token from its owner; it stays in this browser only.</p>
        <div className="field">
          <label htmlFor="access-token">Access token</label>
          <input id="access-token" className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!token.trim()}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
