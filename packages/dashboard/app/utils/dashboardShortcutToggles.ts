import type { ChatLaunchMode } from "./chatLaunchMode";

/*
FNXC:DashboardShortcuts 2026-07-16-00:00:
FN-8069 requires view-backed dashboard shortcuts to remove the exact navigation-history callback that opened their view, then restore the captured prior view. Retain a callback stack per view so repeated Settings/Command Center entries each preserve their own history; keep this identity-sensitive lifecycle outside App's render body for live navigation-history regression coverage (Runfusion/Fusion#2118).
*/
export function retainViewNavRevert<TView>(
  view: TView,
  previousView: TView,
  reverts: Map<TView, (() => void)[]>,
  restoreView: (view: TView) => void,
): () => void {
  const revert = () => {
    const viewReverts = reverts.get(view);
    if (viewReverts) {
      const index = viewReverts.lastIndexOf(revert);
      if (index !== -1) viewReverts.splice(index, 1);
      if (viewReverts.length === 0) reverts.delete(view);
    }
    restoreView(previousView);
  };
  const viewReverts = reverts.get(view) ?? [];
  viewReverts.push(revert);
  reverts.set(view, viewReverts);
  return revert;
}

/*
FNXC:DashboardShortcuts 2026-09-16-02:27:
FN-441 : la liste des chats a DEUX hôtes déjà existants (tiroir plein écran, popover du pied de page) et aucun
nouvel hôte n'est créé.

FNXC:DashboardShortcuts 2026-09-16-19:44:
FN-468 : le choix suit désormais la propriété du SHELL de navigation (`isMobileShellMode`), pas le seul téléphone.
Sous 1024 px — tablette comprise — le pied de page large n'existe plus, donc sa popover n'a plus d'hôte : le
tiroir plein écran est la seule cible valide. Sans projet courant, aucun hôte n'existe : l'action est inerte.
*/
export type ChatListShortcutTarget = "none" | "drawer" | "page" | "popover";

/*
FNXC:DashboardShortcuts 2026-10-08-07:00:
RUFU-326: operator invariant "one selection = one surface". The stored Chat launch mode (owner of the
view/popup branch since RUFU-303) decides which Chat surface the desktop opens, so it is now an INPUT of
this seam. The block above justified purity by "only the shell decides" — that justification WAS the defect:
it licensed each call site to guess the mode on its own, and the keyboard shortcut never did, so
`Ctrl+Shift+L` opened the anchored popover while the nav button opened the Chat page. The seam stays PURE and
its inputs stay MEASURED (`useViewportMode` for the shell, `readStoredChatLaunchMode` for the mode); what
changed is the input SET, not its nature, so the decision remains provable without mounting the shell.

`mobileShellActive` short-circuits the mode: `resolveChatHost` answers `mobile-page` BEFORE placement or dock
state (FN-435/FN-437), so a stored "view" must never mount the desktop popover below 1024 px — the drawer
stays the only valid target for both modes. The parameter is REQUIRED (no default) so every call site states
its intent, and a garbage stored value is already normalized to "popup" by `readStoredChatLaunchMode`, which
keeps today's surface for operators who never touched the preference.
*/
export function resolveChatListShortcutTarget(options: {
  hasProject: boolean;
  mobileShellActive: boolean;
  chatLaunchMode: ChatLaunchMode;
}): ChatListShortcutTarget {
  if (!options.hasProject) return "none";
  if (options.mobileShellActive) return "drawer";
  return options.chatLaunchMode === "view" ? "page" : "popover";
}

/*
FNXC:DashboardShortcuts 2026-09-16-02:27:
Le clavier doit ancrer la popover sur le MÊME élément que le clic pointeur (`desktop-nav-chat-panel`), sans
faire traverser une ref à travers DesktopActionBar. Une ancre absente (footer large inactif, montage tardif)
renvoie `null`, que la géométrie de la popover tolère déjà — jamais une exception.
*/
export function readShortcutAnchorRect(testId: string): DOMRect | null {
  if (typeof document === "undefined") return null;
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!element) return null;
  return element.getBoundingClientRect();
}

export function closeViewShortcut<TView>(
  view: TView,
  reverts: Map<TView, (() => void)[]>,
  removeNav: (revert: () => void) => void,
  onMissingRevert: () => void,
): boolean {
  const viewReverts = reverts.get(view);
  const revert = viewReverts?.at(-1);
  if (!revert) {
    onMissingRevert();
    return false;
  }
  removeNav(revert);
  revert();
  return true;
}
