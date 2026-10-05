/** Lien d'invitation vers une salle : l'accueil le lit pour préremplir le code. */
export function inviteUrl(code: string): string {
  return `${location.origin}/?room=${code}`;
}

/** Copie dans le presse-papiers ; false si le navigateur refuse (http non
 *  local, permissions) — le lien reste alors à copier à la main. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
