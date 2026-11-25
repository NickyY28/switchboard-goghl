export type Workspace = {
  id: string;
  role: string;
};

export type CurrentUser = {
  sub: string;
  workspaces: Workspace[];
};

export type Message = {
  id: string;
  text: string;
  direction: 'inbound' | 'outbound';
  createdAt: string;
  status: 'received' | 'queued' | 'sent' | 'delivered' | 'failed' | null;
  clientRef?: string | null;
};

export type Conversation = {
  contact: string;
  assignee: string | null;
  state: 'open' | 'closed';
  unreadCount: number;
  priority: boolean;
  lastActivityAt: string;
  lastMessage?: Pick<Message, 'id' | 'text' | 'direction' | 'createdAt'> | null;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // Keep the HTTP status message when the server does not return JSON.
    }
    throw new ApiError(message, response.status);
  }

  if (!response.headers.get('content-type')?.includes('application/json')) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function getCurrentUser(signal?: AbortSignal) {
  return requestJson<CurrentUser>('/api/me', { signal });
}

export function getConversations(
  workspace: string,
  state?: 'open' | 'closed',
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ workspace });
  if (state) query.set('state', state);
  return requestJson<Conversation[]>(`/api/conversations?${query}`, { signal });
}

export function getMessages(workspace: string, contact: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ workspace });
  return requestJson<Message[]>(
    `/api/conversations/${encodeURIComponent(contact)}/messages?${query}`,
    { signal },
  );
}

export function claimConversation(workspace: string, contact: string) {
  return requestJson<void>(
    `/api/conversations/${encodeURIComponent(contact)}/claim`,
    { method: 'POST', body: JSON.stringify({ workspace }) },
  );
}

export function sendReply(workspace: string, contact: string, text: string, clientRef: string) {
  return requestJson<void>(
    '/api/replies',
    {
      method: 'POST',
      body: JSON.stringify({ workspace, contact, text, client_ref: clientRef }),
    },
  );
}

export function markConversationRead(workspace: string, contact: string) {
  return requestJson<void>(
    `/api/conversations/${encodeURIComponent(contact)}/read`,
    { method: 'POST', body: JSON.stringify({ workspace }) },
  );
}

export function setConversationPriority(workspace: string, contact: string, priority: boolean) {
  return requestJson<void>(
    `/api/conversations/${encodeURIComponent(contact)}/priority`,
    { method: 'PATCH', body: JSON.stringify({ workspace, priority }) },
  );
}

export function setConversationState(
  workspace: string,
  contact: string,
  state: 'open' | 'closed',
) {
  return requestJson<void>(
    `/api/conversations/${encodeURIComponent(contact)}/state`,
    { method: 'PATCH', body: JSON.stringify({ workspace, state }) },
  );
}
