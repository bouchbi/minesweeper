import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store';

/**
 * Modération des records, à lancer à côté du serveur :
 *   node dist-server/admin.mjs records            liste avec les identifiants
 *   node dist-server/admin.mjs delete-record <id> retire une ligne
 * Dans le conteneur : `docker exec <conteneur> node dist-server/admin.mjs records`.
 * Le classement servi à l'accueil se met à jour au prochain record (ou au
 * redémarrage du serveur).
 */
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = new Store(resolve(PROJECT_DIR, process.env.DATA_DIR ?? 'data'));
const [cmd, arg] = process.argv.slice(2);

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

if (cmd === 'records') {
  for (const r of store.listRecords()) {
    console.log(
      `#${r.id}\t${r.preset}\t${r.bonus ? 'bonus' : '-'}\t${r.mode}\t${fmt(r.elapsedMs)}\t${r.names.join(', ')}`,
    );
  }
} else if (cmd === 'delete-record' && arg) {
  console.log(store.deleteRecord(Number(arg)) ? `Record #${arg} supprimé.` : `Aucun record #${arg}.`);
} else {
  console.log('Usage : admin.mjs records | admin.mjs delete-record <id>');
  process.exitCode = 1;
}
store.close();
