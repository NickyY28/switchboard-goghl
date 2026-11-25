import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  claimConversation,
  getConversations,
  getCurrentUser,
  getMessages,
  markConversationRead,
  sendReply,
  setConversationPriority,
  setConversationState,
  type Conversation,
  type CurrentUser,
  type Message,
  type Workspace,
} from './api';
import './App.css';

type AuthState = 'checking' | 'signed-in' | 'signed-out' | 'error';

function workspaceName(id: string) {
  if (id === 'ws_acme') return 'Acme Support';
  if (id === 'ws_globex') return 'Globex Support';
  return id;
}

function initials(value: string) {
  const parts = value.trim().split(/[\s@._-]+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
    : value.slice(0, 2).toUpperCase();
}

function formatTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  if (date.toDateString() !== today.toDateString()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function errorText(error: unknown) {
  if (error instanceof ApiError && error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error instanceof ApiError && error.status === 403) return 'You do not have access to this workspace.';
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function LoginScreen({ message }: { message?: string }) {
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="brand-mark brand-mark-large" aria-hidden="true">S</div>
        <p className="eyebrow">TEAM INBOX</p>
        <h1>Good support starts here.</h1>
        <p className="login-description">
          Sign in to pick up conversations and help your customers.
        </p>
        {message ? <div className="notice notice-error">{message}</div> : null}
        <a className="primary-button login-button" href="/auth/login">
          Continue with company sign-in
          <span aria-hidden="true">→</span>
        </a>
      </section>
      <p className="login-caption">Switchboard · Conversations, together.</p>
    </main>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return <div className="empty-state"><span className="loading-dot" />{label}</div>;
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [authError, setAuthError] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [conversationFilter, setConversationFilter] = useState<'all' | 'open' | 'closed'>('open');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedContact, setSelectedContact] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [conversationError, setConversationError] = useState('');
  const [messagesError, setMessagesError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [updatingConversation, setUpdatingConversation] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [socketConnected, setSocketConnected] = useState(false);
  const lastSeq = useRef(0);
  const selectedContactRef = useRef(selectedContact);

  useEffect(() => {
    selectedContactRef.current = selectedContact;
  }, [selectedContact]);

  useEffect(() => {
    const controller = new AbortController();
    getCurrentUser(controller.signal)
      .then((currentUser) => {
        setUser(currentUser);
        setWorkspaceId(currentUser.workspaces[0]?.id ?? '');
        setAuthState('signed-in');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          setAuthState('signed-out');
          return;
        }
        setAuthError(errorText(error));
        setAuthState('error');
      });
    return () => controller.abort();
  }, []);

  const apiState = conversationFilter === 'all' ? undefined : conversationFilter;
  const refreshConversations = useCallback(async (workspace: string, state = apiState) => {
    const result = await getConversations(workspace, state);
    setConversations(result);
    setConversationError('');
    return result;
  }, [apiState]);

  const refreshMessages = useCallback(async (workspace: string, contact: string) => {
    const result = await getMessages(workspace, contact);
    if (selectedContactRef.current === contact) {
      setMessages(result);
      setMessagesError('');
    }
    return result;
  }, []);

  useEffect(() => {
    if (authState !== 'signed-in' || !workspaceId) {
      setConversations([]);
      return;
    }

    const controller = new AbortController();
    setConversationLoading(true);
    setConversationError('');
    setConversations([]);
    setSelectedContact('');

    getConversations(workspaceId, apiState, controller.signal)
      .then((result) => {
        setConversations(result);
        setSelectedContact((current) =>
          result.some((conversation) => conversation.contact === current)
            ? current
            : result[0]?.contact ?? '',
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setConversationError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setConversationLoading(false);
      });

    return () => controller.abort();
  }, [apiState, authState, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !selectedContact || authState !== 'signed-in') {
      setMessages([]);
      return;
    }

    const controller = new AbortController();
    setMessagesLoading(true);
    setMessagesError('');
    setMessages([]);
    getMessages(workspaceId, selectedContact, controller.signal)
      .then((result) => setMessages(result))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setMessagesError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setMessagesLoading(false);
      });

    return () => controller.abort();
  }, [authState, workspaceId, selectedContact]);

  useEffect(() => {
    if (authState !== 'signed-in' || !workspaceId) {
      setSocketConnected(false);
      return;
    }

    lastSeq.current = 0;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let stopped = false;
    let retryDelay = 500;

    const connect = () => {
      if (stopped) return;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const query = new URLSearchParams({ workspace: workspaceId });
      if (lastSeq.current > 0) query.set('after', String(lastSeq.current));
      socket = new WebSocket(`${scheme}//${window.location.host}/ws?${query}`);

      socket.addEventListener('open', () => {
        retryDelay = 500;
        setSocketConnected(true);
      });

      socket.addEventListener('message', (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { seq?: number; type?: string };
          if (typeof frame.seq !== 'number' || frame.seq <= lastSeq.current) return;
          lastSeq.current = frame.seq;
          void refreshConversations(workspaceId).catch((error: unknown) =>
            setConversationError(errorText(error)),
          );
          const contact = selectedContactRef.current;
          if (contact) {
            void refreshMessages(workspaceId, contact).catch((error: unknown) =>
              setMessagesError(errorText(error)),
            );
          }
        } catch {
          setActionError('Received an unreadable live update from the server.');
        }
      });

      socket.addEventListener('close', () => {
        setSocketConnected(false);
        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
      });

      socket.addEventListener('error', () => socket?.close());
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
      setSocketConnected(false);
    };
  }, [authState, workspaceId, refreshConversations, refreshMessages]);

  const workspace: Workspace | undefined = user?.workspaces.find((item) => item.id === workspaceId);
  const activeConversation = conversations.find((item) => item.contact === selectedContact);
  const visibleConversations = conversations
    .filter((conversation) => {
      const query = searchText.trim().toLowerCase();
      return !query || conversation.contact.toLowerCase().includes(query) ||
        conversation.lastMessage?.text.toLowerCase().includes(query);
    })
    .sort((a, b) => Number(b.priority) - Number(a.priority) ||
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());

  useEffect(() => {
    if (!workspaceId || !activeConversation || activeConversation.unreadCount < 1) return;
    const contact = activeConversation.contact;
    setConversations((current) => current.map((conversation) =>
      conversation.contact === contact ? { ...conversation, unreadCount: 0 } : conversation,
    ));
    markConversationRead(workspaceId, contact).catch((error: unknown) => {
      setActionError(errorText(error));
      void refreshConversations(workspaceId).catch((refreshError: unknown) =>
        setConversationError(errorText(refreshError)),
      );
    });
  }, [activeConversation?.contact, activeConversation?.unreadCount, refreshConversations, workspaceId]);

  async function handleClaim() {
    if (!workspaceId || !activeConversation) return;
    setClaiming(true);
    setActionError('');
    setActionNotice('');
    try {
      await claimConversation(workspaceId, activeConversation.contact);
      await refreshConversations(workspaceId);
      setActionNotice('Conversation claimed.');
    } catch (error) {
      setActionError(errorText(error));
      if (error instanceof ApiError && error.status === 409) {
        void refreshConversations(workspaceId).catch((refreshError: unknown) =>
          setConversationError(errorText(refreshError)),
        );
      }
    } finally {
      setClaiming(false);
    }
  }

  async function handlePriority() {
    if (!workspaceId || !activeConversation) return;
    setUpdatingConversation(true);
    setActionError('');
    setActionNotice('');
    try {
      await setConversationPriority(workspaceId, activeConversation.contact, !activeConversation.priority);
      await refreshConversations(workspaceId);
      setActionNotice(activeConversation.priority ? 'Priority removed.' : 'Marked as priority.');
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setUpdatingConversation(false);
    }
  }

  async function handleStateChange() {
    if (!workspaceId || !activeConversation) return;
    const nextState = activeConversation.state === 'open' ? 'closed' : 'open';
    setUpdatingConversation(true);
    setActionError('');
    setActionNotice('');
    try {
      await setConversationState(workspaceId, activeConversation.contact, nextState);
      const updated = await refreshConversations(workspaceId);
      if (conversationFilter !== 'all' && conversationFilter !== nextState) {
        setSelectedContact(updated[0]?.contact ?? '');
      }
      setActionNotice(nextState === 'closed' ? 'Conversation closed.' : 'Conversation reopened.');
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setUpdatingConversation(false);
    }
  }

  async function handleReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = replyText.trim();
    if (!text || !workspaceId || !activeConversation || replying) return;
    setReplying(true);
    setActionError('');
    setActionNotice('');
    const clientRef = globalThis.crypto?.randomUUID?.() ??
      `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await sendReply(workspaceId, activeConversation.contact, text, clientRef);
      setReplyText('');
      setActionNotice('Reply queued.');
      await refreshMessages(workspaceId, activeConversation.contact);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setReplying(false);
    }
  }

  if (authState === 'checking') {
    return <main className="login-page"><LoadingPanel label="Checking your session…" /></main>;
  }
  if (authState === 'signed-out') return <LoginScreen />;
  if (authState === 'error') return <LoginScreen message={authError} />;

  return (
    <main className="app-shell">
      <aside className="side-rail" aria-label="Main navigation">
        <a className="brand-mark" href="/" aria-label="Switchboard home">S</a>
        <button className="rail-button rail-button-active" aria-label="Inbox" title="Inbox">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v13H4zM4 13h4l1.5 2h5L16 13h4" /></svg>
        </button>
        <div className="rail-spacer" />
        <span className="rail-avatar" aria-label={`Signed in as ${user?.sub}`} title={user?.sub}>
          {initials(user?.sub ?? 'Agent')}
        </span>
      </aside>

      <section className="inbox-column">
        <header className="workspace-header">
          <label className="workspace-select-wrap">
            <span className="workspace-icon">{workspace ? initials(workspaceName(workspace.id)) : '?'}</span>
            <select
              aria-label="Select workspace"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              disabled={!user?.workspaces.length}
            >
              {(user?.workspaces ?? []).map((item) => (
                <option key={item.id} value={item.id}>{workspaceName(item.id)}</option>
              ))}
            </select>
            <span className="select-chevron" aria-hidden="true">⌄</span>
          </label>
          {workspace ? <span className="workspace-role">{workspace.role}</span> : null}
        </header>

        <div className="inbox-heading">
          <div>
            <p className="eyebrow">YOUR TEAM</p>
            <h1>Inbox</h1>
          </div>
          <span className={`connection-indicator${socketConnected ? ' connection-online' : ''}`}>
            <span />{socketConnected ? 'Live' : 'Connecting'}
          </span>
        </div>

        <label className="search-box">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4 4" /></svg>
          <input
            type="search"
            placeholder="Search conversations"
            aria-label="Search conversations"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </label>

        <div className="list-tabs" aria-label="Inbox filter">
          {(['open', 'closed', 'all'] as const).map((filter) => (
            <button
              className={`list-tab${conversationFilter === filter ? ' list-tab-active' : ''}`}
              key={filter}
              onClick={() => setConversationFilter(filter)}
            >
              {filter === 'all' ? 'All' : filter === 'open' ? 'Open' : 'Closed'}
              {conversationFilter === filter ? <span>{conversations.length}</span> : null}
            </button>
          ))}
        </div>

        <div className="conversation-list">
          {conversationLoading ? <LoadingPanel label="Loading inbox…" /> : null}
          {!conversationLoading && conversationError ? (
            <div className="inline-error">{conversationError}</div>
          ) : null}
          {!conversationLoading && !conversationError && visibleConversations.length === 0 ? (
            <div className="list-empty">{searchText ? 'No matching conversations.' : 'No conversations yet.'}</div>
          ) : null}
          {!conversationLoading && visibleConversations.map((conversation, index) => (
            <button
              className={`conversation-row${conversation.contact === activeConversation?.contact ? ' conversation-row-active' : ''}`}
              key={conversation.contact}
              onClick={() => setSelectedContact(conversation.contact)}
            >
              <span className={`contact-avatar ${index % 2 ? 'mint' : 'lilac'}`}>
                {initials(conversation.contact)}
              </span>
              <span className="conversation-copy">
                <span className="conversation-topline">
                  <strong>{conversation.contact}</strong>
                  <time>{formatTime(conversation.lastActivityAt)}</time>
                </span>
                <span className="conversation-preview">
                  {conversation.lastMessage?.text ?? (conversation.priority ? 'Priority conversation' : `${conversation.state} conversation`)}
                </span>
                <span className="conversation-contact">
                  {conversation.assignee ? `Assigned to ${conversation.assignee}` : 'Unassigned'}
                  {conversation.priority ? ' · Priority' : ''}
                </span>
              </span>
              {conversation.unreadCount > 0 ? (
                <span className="unread-count">{conversation.unreadCount}</span>
              ) : null}
            </button>
          ))}
        </div>

        <footer className="inbox-footer">
          <span className={`online-dot${socketConnected ? '' : ' offline-dot'}`} />
          <span>{socketConnected ? 'Live updates connected' : 'Reconnecting to live updates'}</span>
          <span className="signed-in-user">{user?.sub}</span>
        </footer>
      </section>

      <section className="conversation-panel" aria-label="Conversation">
        {!selectedContact && !conversationLoading ? (
          <div className="empty-state">
            {conversationError ? 'Inbox could not be loaded.' : 'Select a conversation to view messages.'}
          </div>
        ) : null}
        {activeConversation ? (
          <>
            <header className="conversation-header">
              <div className="contact-avatar lilac">{initials(activeConversation.contact)}</div>
              <div className="conversation-identity">
                <h2>{activeConversation.contact}</h2>
                <p>{activeConversation.assignee ? `Assigned to ${activeConversation.assignee}` : 'Not assigned'}</p>
              </div>
              <div className="header-actions">
                <button
                  className="claim-button"
                  onClick={handleClaim}
                  disabled={claiming || Boolean(activeConversation.assignee)}
                >
                  {claiming ? 'Claiming…' : activeConversation.assignee ? 'Assigned' : 'Claim'}
                </button>
                <button
                  className={`icon-button priority-button${activeConversation.priority ? ' priority-active' : ''}`}
                  onClick={handlePriority}
                  disabled={updatingConversation}
                  aria-label={activeConversation.priority ? 'Remove priority' : 'Mark priority'}
                  aria-pressed={activeConversation.priority}
                  title={activeConversation.priority ? 'Remove priority' : 'Mark priority'}
                >
                  {activeConversation.priority ? '★' : '☆'}
                </button>
                <button
                  className="state-button"
                  onClick={handleStateChange}
                  disabled={updatingConversation}
                >
                  {updatingConversation ? 'Saving…' : activeConversation.state === 'open' ? 'Close' : 'Reopen'}
                </button>
              </div>
            </header>
            <div className="message-area">
              {messagesLoading ? <LoadingPanel label="Loading messages…" /> : null}
              {!messagesLoading && messagesError ? <div className="inline-error">{messagesError}</div> : null}
              {!messagesLoading && !messagesError && messages.length === 0 ? (
                <div className="list-empty">No messages in this conversation yet.</div>
              ) : null}
              {!messagesLoading && messages.map((message) => (
                <article className={`message message-${message.direction}`} key={message.id}>
                  {message.direction === 'inbound' ? (
                    <span className="message-avatar lilac">{initials(activeConversation.contact)}</span>
                  ) : null}
                  <div className="message-content">
                    <div className="message-meta">
                      <strong>{message.direction === 'inbound' ? activeConversation.contact : 'You'}</strong>
                      <time>{formatTime(message.createdAt)}</time>
                    </div>
                    <p>{message.text}</p>
                    {message.direction === 'outbound' && message.status ? (
                      <span className={`message-status status-${message.status}`}>{message.status}</span>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
            <div className="composer-wrap">
              {actionError ? <div className="notice notice-error">{actionError}</div> : null}
              {actionNotice ? <div className="notice notice-success">{actionNotice}</div> : null}
              <form className="reply-composer" onSubmit={handleReply}>
                <textarea
                  aria-label="Write a reply"
                  placeholder={`Reply to ${activeConversation.contact}…`}
                  value={replyText}
                  onChange={(event) => setReplyText(event.target.value)}
                  rows={2}
                />
                <div className="composer-actions">
                  <span>Replies are sent to the customer</span>
                  <button className="send-button" type="submit" disabled={replying || !replyText.trim()}>
                    {replying ? 'Sending…' : 'Send reply'}
                    <span aria-hidden="true">↑</span>
                  </button>
                </div>
              </form>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
