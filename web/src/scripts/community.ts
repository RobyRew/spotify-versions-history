/**
 * The release page's community section with script: likes and reactions update in place (the ui
 * kit shows them at once; this sends them and puts the server's numbers back), and the comment
 * forms post with fetch, so a refused comment keeps its draft. Every request goes to the same
 * form endpoint the plain forms use, asking for JSON.
 */
import { setBusy, setLike, setReaction, toast } from '@robyrew/ui/behaviors.js';
import '@robyrew/ui/components/GlassToast.css';

interface Answer {
  ok?: boolean;
  error?: string;
  message?: string;
  signIn?: string;
  location?: string;
  [key: string]: unknown;
}

const section = document.querySelector<HTMLElement>('[data-community]');

async function send(form: HTMLFormElement, extra: Record<string, string>): Promise<{ status: number; body: Answer }> {
  const data = new FormData(form);
  for (const [name, value] of Object.entries(extra)) data.set(name, value);
  try {
    const response = await fetch(form.action, { method: 'POST', body: data, headers: { accept: 'application/json' }, credentials: 'same-origin' });
    const body = (await response.json().catch(() => ({}))) as Answer;
    return { status: response.status, body };
  } catch {
    return { status: 0, body: { message: 'The site could not be reached. Check your connection and try again.' } };
  }
}

function refused(status: number, body: Answer): void {
  if (status === 401 && body.signIn) {
    location.assign(body.signIn);
    return;
  }
  toast({ title: body.message ?? 'That didn’t work. Try again.', tone: status === 429 ? 'warn' : 'error' });
}

/** Signed out with sign-in available: any press goes to sign-in instead. */
const signIn = (): string | undefined => section?.dataset.signIn;

if (section) {
  // The notice of the last action showed once; a reload should not show it again.
  if (new URLSearchParams(location.search).has('notice')) {
    const url = new URL(location.href);
    url.searchParams.delete('notice');
    history.replaceState(history.state, '', url);
  }

  section.addEventListener('rw:like', event => {
    const { detail, target } = event as CustomEvent<{ liked: boolean; count: number; previous: { liked: boolean; count: number } }>;
    const button = target as HTMLElement;
    const form = button.closest('form');
    if (!form) return;
    event.preventDefault();
    const away = signIn();
    if (away) {
      queueMicrotask(() => setLike(button, detail.previous));
      location.assign(away);
      return;
    }
    void send(form, { value: detail.liked ? '1' : '0' }).then(({ status, body }) => {
      if (status === 200 && typeof body.count === 'number') setLike(button, { liked: body.liked === true, count: body.count });
      else {
        setLike(button, detail.previous);
        refused(status, body);
      }
    });
  });

  section.addEventListener('rw:react', event => {
    const { detail, target } = event as CustomEvent<{ emoji: string; mine: boolean; count: number; previous: { mine: boolean; count: number } }>;
    const bar = target as HTMLElement;
    if (!(bar instanceof HTMLFormElement)) return;
    event.preventDefault();
    const away = signIn();
    if (away) {
      queueMicrotask(() => setReaction(bar, detail.emoji, detail.previous));
      location.assign(away);
      return;
    }
    void send(bar, { emoji: detail.emoji, on: detail.mine ? '1' : '0' }).then(({ status, body }) => {
      if (status === 200 && typeof body.count === 'number') setReaction(bar, detail.emoji, { count: body.count, mine: body.mine === true });
      else {
        setReaction(bar, detail.emoji, detail.previous);
        refused(status, body);
      }
    });
  });

  // Comments, replies, edits, deletions, reports and reviews: on success, load the page the
  // server names (it shows the result and scrolls to it); on refusal, keep the form as it is.
  section.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.action.endsWith('/act') || form.classList.contains('rw-like-form') || form.hasAttribute('data-rw-react')) return;
    if (form.dataset.confirm && !confirm(form.dataset.confirm)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter;
    const extra: Record<string, string> = submitter instanceof HTMLButtonElement && submitter.name ? { [submitter.name]: submitter.value } : {};
    setBusy(form, true);
    void send(form, extra).then(({ status, body }) => {
      if (status === 200 && body.location) {
        const next = new URL(body.location, location.href);
        if (next.pathname + next.search === location.pathname + location.search) {
          history.replaceState(history.state, '', next);
          location.reload();
        } else location.assign(next);
        return;
      }
      setBusy(form, false);
      refused(status, body);
    });
  });
}
