import { useState, type FormEvent } from "react";
import { MessageSquare, Send } from "lucide-react";
import { stamp, type Doc, type State } from "./types";

export function CommentCount({
  s,
  documentId,
}: {
  s: State;
  documentId: string;
}) {
  const count = s.comments.filter(
    (comment) => comment.documentId === documentId,
  ).length;
  return count ? (
    <small className="comment-count">
      <MessageSquare size={12} aria-hidden="true" />
      Комментарии: {count}
    </small>
  ) : null;
}

export function Comments({
  doc,
  s,
  busy,
  run,
}: {
  doc: Doc;
  s: State;
  busy: boolean;
  run: (
    path: string,
    body: { text: string },
    method: string,
    success: string,
    close: boolean,
  ) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(""),
    [sending, setSending] = useState(false);
  const comments = s.comments.filter(
    (comment) => comment.documentId === doc.id,
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || sending || !draft.trim() || draft.length > 2000) return;
    setSending(true);
    try {
      const result = await run(
        `/documents/${doc.id}/comments`,
        { text: draft },
        "POST",
        "Комментарий добавлен",
        false,
      );
      if (result) setDraft("");
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="document-comments" aria-label="Комментарии к документу">
      <div className="comments-heading">
        <MessageSquare size={19} aria-hidden="true" />
        <h3>
          Комментарии <span>{comments.length}</span>
        </h3>
      </div>
      {!comments.length && <p className="muted">Комментариев пока нет.</p>}
      <div className="comments-list">
        {comments.map((comment) => (
          <article
            key={comment.id}
            className={
              "comment-card" + (comment.authorId === s.me.id ? " mine" : "")
            }
          >
            <div className="comment-meta">
              <b>{comment.authorName}</b>
              <time dateTime={comment.at}>{stamp(comment.at, s.timeZone)}</time>
            </div>
            <p className="comment-text">{comment.text}</p>
          </article>
        ))}
      </div>
      {!doc.deleted && (
        <form onSubmit={submit} className="comment-form">
          <label className="field">
            Новый комментарий
            <textarea
              aria-label="Новый комментарий"
              rows={3}
              maxLength={2000}
              value={draft}
              disabled={busy || sending}
              placeholder="Добавьте пояснение к документу"
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="comment-footer">
            <small>{draft.length}/2000</small>
            <button
              type="submit"
              className="button"
              disabled={busy || sending || !draft.trim()}
            >
              <Send size={16} />
              {sending ? "Отправляем…" : "Добавить комментарий"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
