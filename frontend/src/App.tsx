import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image as ImageIcon, MessageCircle, Search, Send, Trash2, X, Plus,
  Sparkles, UserRound, LogOut, Clock3
} from "lucide-react";

const MAX_IMAGE = 99 * 1024;
const API = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

type User = { id: number; username: string };
type Post = {
  id: number; content: string; imagePath?: string | null; createdAt: number;
  userId: number; username: string; replyCount: number;
};
type Story = {
  id: number; content: string; imagePath?: string | null; createdAt: number;
  expiresAt: number; userId: number; username: string;
};
type Reply = { id: number; content: string; createdAt: number; userId: number; username: string };
type ConnectionState = "connecting" | "connected" | "temporary-failure" | "api-error";

type FailureKind = "configuration" | "timeout" | "network" | "api" | "server";
type ApiError = Error & { status?: number; kind?: FailureKind };

function requestError(message: string, kind: FailureKind, status?: number): ApiError {
  const error: ApiError = new Error(message);
  error.kind = kind;
  error.status = status;
  return error;
}

async function api<T>(path: string, options: RequestInit = {}) {
  if (import.meta.env.PROD && !API) throw requestError("The app is missing its API address. Set VITE_API_URL and redeploy the frontend.", "configuration");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const token = localStorage.getItem("bingo_token");
    const headers = new Headers(options.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${API}${path}`, { ...options, headers, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw requestError(data.error || "The API could not complete this request.", response.status >= 500 ? "server" : "api", response.status);
    }
    return data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw requestError("The server did not respond in 30 seconds.", "timeout");
    if (error instanceof TypeError) throw requestError("Could not reach the server. Check your connection and try again.", "network");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assetUrl(path: string) { return path.startsWith("http") ? path : `${API}${path}`; }

function ago(timestamp: number) {
  const diff = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function initials(username: string) {
  return username.slice(0, 2).toUpperCase();
}

function Avatar({ username, small = false }: { username: string; small?: boolean }) {
  return <div className={`avatar ${small ? "avatar-small" : ""}`}>{initials(username)}</div>;
}

function ImagePreview({ src }: { src: string }) {
  return <img className="post-image" src={assetUrl(src)} alt="" loading="lazy" />;
}

function AuthScreen({ onDone }: { onDone: (user: User, token: string) => void }) {
  const [username, setUsername] = useState("");
  const [mode, setMode] = useState<"register" | "access">("register");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await api<{ user: User; token: string }>(
        mode === "register" ? "/api/auth/register" : "/api/auth/access",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }) }
      );
      localStorage.setItem("bingo_token", result.token);
      onDone(result.user, result.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not continue.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="logo-mark">BD</div>
        <div className="eyebrow">tiny social space</div>
        <h1>BINGO DUDE<span>.</span></h1>
        <p className="muted auth-copy">
          Open it. Write it. Keep it.
          <br />No complicated account setup.
        </p>

        <form onSubmit={submit} className="auth-form">
          <label>Your username</label>
          <div className="username-input">
            <span>@</span>
            <input
              autoFocus
              value={username}
              onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="viger"
              maxLength={24}
            />
          </div>
          <button className="primary-button" disabled={busy || username.length < 2}>
            {busy ? "Opening…" : mode === "register" ? "Create my space" : "Open my account"}
            <Send size={16} />
          </button>
          {error && <div className="error">{error}</div>}
        </form>

        <button className="text-button" onClick={() => setMode(mode === "register" ? "access" : "register")}>
          {mode === "register" ? "Already have a username? Access it" : "New here? Create a username"}
        </button>
      </div>
    </main>
  );
}

function Composer({ onCreated }: { onCreated: (post: Post) => void }) {
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function publish() {
    if ((!content.trim() && !file) || busy) return;
    if (file && file.size >= MAX_IMAGE) {
      setError("Keep images under 99 KB.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("content", content);
      if (file) form.append("image", file);
      const result = await api<{ post: Post }>("/api/posts", { method: "POST", body: form });
      setContent("");
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onCreated(result.post);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not publish.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="composer panel">
      <div className="composer-top">
        <div className="composer-dot"><Sparkles size={16} /></div>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value.slice(0, 2000))}
          placeholder="What's on your mind?"
          rows={2}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") publish(); }}
        />
      </div>

      {file && (
        <div className="attachment">
          <ImageIcon size={15} />
          <span>{file.name}</span>
          <span className="muted">{Math.round(file.size / 1024)} KB</span>
          <button onClick={() => { setFile(null); if (inputRef.current) inputRef.current.value = ""; }}><X size={15}/></button>
        </div>
      )}

      {error && <div className="error compact">{error}</div>}

      <div className="composer-bottom">
        <label className="icon-button" title="Attach image">
          <ImageIcon size={18} />
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            onChange={e => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <span className="composer-hint">Ctrl/⌘ + Enter</span>
        <button className="publish-button" onClick={publish} disabled={busy || (!content.trim() && !file)}>
          {busy ? "Posting…" : "Post"} <Send size={15} />
        </button>
      </div>
    </section>
  );
}

function StoryComposer({ onCreated, onClose }: { onCreated: (story: Story) => void; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function publish() {
    if ((!content.trim() && !file) || busy) return;
    if (file && file.size >= MAX_IMAGE) return setError("Keep images under 99 KB.");
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("content", content);
      if (file) form.append("image", file);
      const result = await api<{ story: Story }>("/api/stories", { method: "POST", body: form });
      onCreated(result.story);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not publish story.");
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <div><span className="eyebrow">24 hours</span><h2>New story</h2></div>
          <button className="close-button" onClick={onClose}><X /></button>
        </div>
        <textarea autoFocus value={content} onChange={e => setContent(e.target.value.slice(0, 600))} placeholder="A tiny update…" rows={4} />
        <label className="upload-box">
          <ImageIcon size={20} />
          <span>{file ? `${file.name} · ${Math.round(file.size / 1024)} KB` : "Add an image (optional)"}</span>
          <input type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary-button" onClick={publish} disabled={busy || (!content.trim() && !file)}>
          {busy ? "Publishing…" : "Publish story"} <Clock3 size={16} />
        </button>
      </div>
    </div>
  );
}

function Stories({ stories, currentUser, onAdd, onDelete }: {
  stories: Story[]; currentUser: User; onAdd: () => void; onDelete: (id: number) => void;
}) {
  const [selected, setSelected] = useState<Story | null>(null);

  return (
    <>
      <section className="stories">
        <button className="story-add" onClick={onAdd}>
          <div className="story-add-ring"><Plus /></div>
          <span>your story</span>
        </button>
        {stories.map(story => (
          <button key={story.id} className="story" onClick={() => setSelected(story)}>
            <div className="story-ring"><Avatar username={story.username} /></div>
            <span>@{story.username}</span>
          </button>
        ))}
      </section>

      {selected && (
        <div className="modal-backdrop" onMouseDown={() => setSelected(null)}>
          <div className="story-viewer" onMouseDown={e => e.stopPropagation()}>
            <div className="story-viewer-top">
              <div className="story-author"><Avatar username={selected.username} small /><b>@{selected.username}</b><span>{ago(selected.createdAt)}</span></div>
              <button className="close-button" onClick={() => setSelected(null)}><X /></button>
            </div>
            {selected.imagePath && <img src={assetUrl(selected.imagePath)} alt="" />}
            {selected.content && <div className="story-text">{selected.content}</div>}
            {selected.userId === currentUser.id && (
              <button className="danger-button" onClick={() => { onDelete(selected.id); setSelected(null); }}><Trash2 size={15}/> Delete story</button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ReplyPanel({ post, currentUser, onCountChange }: { post: Post; currentUser: User; onCountChange: (delta: number) => void }) {
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (!open) {
      try {
        const result = await api<{ replies: Reply[] }>(`/api/posts/${post.id}/replies`);
        setReplies(result.replies);
      } catch {}
    }
    setOpen(!open);
  }

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const result = await api<{ reply: Reply }>(`/api/posts/${post.id}/replies`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text })
      });
      setReplies(r => [...r, result.reply]);
      setText("");
      onCountChange(1);
      setOpen(true);
    } finally { setBusy(false); }
  }

  async function remove(id: number) {
    await api(`/api/replies/${id}`, { method: "DELETE" });
    setReplies(r => r.filter(x => x.id !== id));
    onCountChange(-1);
  }

  return (
    <div className="reply-area">
      <button className="reply-toggle" onClick={toggle}><MessageCircle size={16}/> {post.replyCount || "Reply"}</button>
      {open && (
        <div className="replies">
          {replies.map(reply => (
            <div className="reply" key={reply.id}>
              <Avatar username={reply.username} small />
              <div className="reply-body">
                <div className="reply-meta"><b>@{reply.username}</b><span>{ago(reply.createdAt)}</span></div>
                <div>{reply.content}</div>
              </div>
              {reply.userId === currentUser.id && <button className="mini-delete" onClick={() => remove(reply.id)}><Trash2 size={13}/></button>}
            </div>
          ))}
          <div className="reply-input">
            <input value={text} onChange={e => setText(e.target.value.slice(0, 800))} onKeyDown={e => { if (e.key === "Enter") send(); }} placeholder="Write a reply…" />
            <button onClick={send} disabled={busy || !text.trim()}><Send size={15}/></button>
          </div>
        </div>
      )}
    </div>
  );
}

function PostCard({ post, currentUser, onDelete, onCountChange, onProfile }: {
  post: Post; currentUser: User; onDelete: (id: number) => void;
  onCountChange: (id: number, delta: number) => void; onProfile: (username: string) => void;
}) {
  return (
    <article className="post panel">
      <div className="post-head">
        <button className="profile-trigger" onClick={() => onProfile(post.username)}>
          <Avatar username={post.username} />
          <div><b>@{post.username}</b><span>{ago(post.createdAt)}</span></div>
        </button>
        {post.userId === currentUser.id && (
          <button className="delete-button" title="Delete" onClick={() => onDelete(post.id)}><Trash2 size={16}/></button>
        )}
      </div>
      {post.content && <p className="post-content">{post.content}</p>}
      {post.imagePath && <ImagePreview src={post.imagePath} />}
      <ReplyPanel post={post} currentUser={currentUser} onCountChange={delta => onCountChange(post.id, delta)} />
    </article>
  );
}

function Profile({ username, currentUser, onBack, onProfile }: {
  username: string; currentUser: User; onBack: () => void; onProfile: (u: string) => void;
}) {
  const [data, setData] = useState<{ user: User & { createdAt: number }; posts: Post[] } | null>(null);
  useEffect(() => { api<typeof data>(`/api/users/${encodeURIComponent(username)}`).then(setData).catch(() => setData(null)); }, [username]);

  if (!data) return <div className="profile-page panel"><button className="back-button" onClick={onBack}>← Back</button><p className="muted">Loading profile…</p></div>;

  return (
    <div className="profile-page">
      <button className="back-button" onClick={onBack}>← Feed</button>
      <div className="profile-hero panel">
        <Avatar username={data.user.username} />
        <div><div className="eyebrow">profile</div><h2>@{data.user.username}</h2><span className="muted">{data.posts.length} posts</span></div>
      </div>
      <div className="profile-posts">
        {data.posts.map(p => <PostCard key={p.id} post={p} currentUser={currentUser} onDelete={() => {}} onCountChange={() => {}} onProfile={onProfile} />)}
        {!data.posts.length && <div className="empty panel">No posts yet.</div>}
      </div>
    </div>
  );
}

function SearchOverlay({ onClose, onProfile }: { onClose: () => void; onProfile: (u: string) => void }) {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<{ users: User[]; posts: Post[] }>({ users: [], posts: [] });

  useEffect(() => {
    if (!q.trim()) return setResult({ users: [], posts: [] });
    const timer = setTimeout(() => api<typeof result>(`/api/search?q=${encodeURIComponent(q)}`).then(setResult).catch(() => {}), 180);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <div className="search-overlay">
      <div className="search-box">
        <div className="search-top"><Search/><input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search people or posts…" /><button onClick={onClose}><X/></button></div>
        {q && (
          <div className="search-results">
            {result.users.map(u => <button className="search-user" key={u.id} onClick={() => { onProfile(u.username); onClose(); }}><Avatar username={u.username} small/><b>@{u.username}</b></button>)}
            {result.posts.map(p => <button className="search-post" key={p.id} onClick={() => { onProfile(p.username); onClose(); }}><b>@{p.username}</b><span>{p.content || "image post"}</span></button>)}
            {!result.users.length && !result.posts.length && <div className="empty-search">Nothing found.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function FeedSkeleton({ showWakingUp }: { showWakingUp: boolean }) {
  return (
    <>
      {showWakingUp && (
        <div className="waking-up-banner">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className="spinner" />
            <span>Waking up server… Render free instances can take ~20-30s.</span>
          </div>
        </div>
      )}
      <div className="welcome">
        <div>
          <div className="eyebrow">your little corner of the internet</div>
          <h1>What's happening?</h1>
        </div>
        <div className="online-note"><span></span> live space</div>
      </div>
      <div className="stories" style={{ opacity: 0.7 }}>
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="story" style={{ pointerEvents: "none" }}>
            <div className="skeleton skeleton-story" />
            <div className="skeleton skeleton-line short" style={{ height: "10px", marginTop: "4px", width: "40px" }} />
          </div>
        ))}
      </div>
      <div className="panel composer" style={{ padding: "16px", marginBottom: "25px", opacity: 0.7 }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div className="skeleton skeleton-avatar" />
          <div style={{ flex: 1 }}>
            <div className="skeleton skeleton-line medium" />
            <div className="skeleton skeleton-line short" />
          </div>
        </div>
      </div>
      <div className="feed-label"><span>Latest</span><i /></div>
      <section className="feed" style={{ opacity: 0.7 }}>
        {[1, 2, 3].map(i => (
          <div key={i} className="post panel" style={{ padding: "16px" }}>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px" }}>
              <div className="skeleton skeleton-avatar" />
              <div style={{ flex: 1 }}>
                <div className="skeleton skeleton-line short" />
                <div className="skeleton skeleton-line" style={{ width: "25%", height: "10px" }} />
              </div>
            </div>
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line medium" />
          </div>
        ))}
      </section>
    </>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [storyComposer, setStoryComposer] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [profile, setProfile] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => Boolean(localStorage.getItem("bingo_token")));
  const [showWakingUp, setShowWakingUp] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setConnection("connecting");
    setLoadError("");
    const token = localStorage.getItem("bingo_token");

    try {
      await api<{ ok: true }>("/api/health");
      setConnection("connected");
      if (!token) { setUser(null); return; }
      const me = await api<{ user: User }>("/api/me");
      setUser(me.user);
      const feed = await api<{ posts: Post[]; stories: Story[] }>("/api/feed");
      setPosts(feed.posts);
      setStories(feed.stories);
      setLoadError("");
    } catch (err: any) {
      if (err?.status === 401) {
        localStorage.removeItem("bingo_token");
        setUser(null);
      } else {
        const apiError = err as ApiError;
        const temporary = apiError?.kind === "timeout" || apiError?.kind === "network" || [502, 503, 504].includes(apiError?.status ?? 0);
        setConnection(temporary ? "temporary-failure" : "api-error");
        setLoadError(apiError instanceof Error ? apiError.message : "Could not connect to the backend server.");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    let timer: any;
    if (loading) {
      timer = setTimeout(() => setShowWakingUp(true), 3000);
    } else {
      setShowWakingUp(false);
    }
    return () => clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    const timer = setInterval(() => {
      setPosts(p => p.map(x => ({ ...x })));
      setStories(s => s.filter(x => x.expiresAt > Date.now()));
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  const sortedPosts = useMemo(() => [...posts].sort((a, b) => b.createdAt - a.createdAt), [posts]);

  async function deletePost(id: number) {
    setError("");
    try {
      await api(`/api/posts/${id}`, { method: "DELETE" });
      setPosts(p => p.filter(x => x.id !== id));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not delete."); }
  }

  async function deleteStory(id: number) {
    try {
      await api(`/api/stories/${id}`, { method: "DELETE" });
      setStories(s => s.filter(x => x.id !== id));
    } catch {}
  }

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    localStorage.removeItem("bingo_token");
    setUser(null);
    setLoadError("");
  }

  const hasToken = Boolean(localStorage.getItem("bingo_token"));
  const connectionLabel = connection === "connected" ? "connected" : connection === "connecting" ? "connecting" : connection === "temporary-failure" ? "connection retry needed" : "API needs attention";
  const failureTitle = connection === "temporary-failure" ? "Couldn't reach the backend" : "The backend returned an error";
  if (!user && !loading && !hasToken && !loadError) {
    return <AuthScreen onDone={(u) => { setUser(u); load(); }} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setProfile(null)}>
          <span className="brand-dot">BD</span>
          <span>BINGO DUDE<span>.</span></span>
        </button>
        <div className="top-actions">
          {user ? (
            <>
              <button className="nav-icon" onClick={() => setSearchOpen(true)} title="Search"><Search size={19}/></button>
              <button className="user-pill" onClick={() => setProfile(user.username)}><Avatar username={user.username} small/><span>@{user.username}</span></button>
              <button className="nav-icon" onClick={logout} title="Log out"><LogOut size={17}/></button>
            </>
          ) : (
            <div className="user-pill" style={{ opacity: 0.8 }}>
              <span style={{ color: "var(--accent)", fontSize: "10px" }}>●</span>
              <span>{connectionLabel}</span>
            </div>
          )}
        </div>
      </header>

      <main className="main">
        {loading ? (
          <FeedSkeleton showWakingUp={showWakingUp} />
        ) : loadError && !user ? (
          <div className="panel wake-error-card">
            <h3>{failureTitle}</h3>
            <p>{loadError} {connection === "temporary-failure" && "If the Render service was asleep, it can take a short time to wake up."}</p>
            <div className="retry-actions">
              <button className="primary-button" onClick={load}>Retry Connection</button>
              <button className="secondary-button" onClick={logout}>Use Another Account</button>
            </div>
          </div>
        ) : user ? (
          profile ? (
            <Profile username={profile} currentUser={user} onBack={() => setProfile(null)} onProfile={setProfile} />
          ) : (
            <>
              <div className="welcome">
                <div>
                  <div className="eyebrow">your little corner of the internet</div>
                  <h1>What's happening?</h1>
                </div>
                <div className={`online-note ${connection !== "connected" ? `connection-${connection}` : ""}`}><span></span> {connectionLabel}</div>
              </div>

              <Stories
                stories={stories}
                currentUser={user}
                onAdd={() => setStoryComposer(true)}
                onDelete={deleteStory}
              />

              <Composer onCreated={post => setPosts(p => [post, ...p])} />

              {error && <div className="error page-error">{error}</div>}

              <div className="feed-label"><span>Latest</span><i /></div>

              <section className="feed">
                {sortedPosts.map(post => (
                  <PostCard
                    key={post.id}
                    post={post}
                    currentUser={user}
                    onDelete={deletePost}
                    onCountChange={(id, delta) => setPosts(p => p.map(x => x.id === id ? { ...x, replyCount: Math.max(0, x.replyCount + delta) } : x))}
                    onProfile={setProfile}
                  />
                ))}
                {!sortedPosts.length && (
                  <div className="empty panel">
                    <Sparkles size={22}/>
                    <b>The space is quiet.</b>
                    <span>Be the first person to leave something here.</span>
                  </div>
                )}
              </section>
            </>
          )
        ) : (
          <AuthScreen onDone={(u) => { setUser(u); load(); }} />
        )}
      </main>

      <footer className="footer">BINGO DUDE · small internet, big ideas</footer>

      {storyComposer && user && (
        <StoryComposer
          onCreated={story => setStories(s => [story, ...s])}
          onClose={() => setStoryComposer(false)}
        />
      )}

      {searchOpen && user && <SearchOverlay onClose={() => setSearchOpen(false)} onProfile={setProfile} />}
    </div>
  );
}
