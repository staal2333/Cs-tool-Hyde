import { requireAuth } from '../lib/auth.js';
import { addContact, updateContact, deleteContact, restoreContact, effectiveContacts } from '../lib/contacts.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const { action, company, contact, patch } = req.body || {};
    if (action === 'add') await addContact(contact || {});
    else if (action === 'update') await updateContact(company, patch || {});
    else if (action === 'delete') await deleteContact(company, false);
    else if (action === 'restore') await restoreContact(company);
    else return res.status(400).json({ error: 'bad_action' });
    return res.status(200).json({ ok: true, contacts: await effectiveContacts() });
  } catch (err) {
    console.error('contacts error', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
}
