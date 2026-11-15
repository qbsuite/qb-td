// warnask.js — a warning that asks before going on, for the hub (Release
// packet with rooms that haven't started) and the room page (a game about
// to start on another round's packet). A dialog over the page with Cancel
// focused; the other answers stay deaf for a moment after it opens, so
// the second click of a double click can't answer it. A click outside it
// does nothing: only a button or Escape (Cancel) closes it.
//
//   const k = await askWarning({ title, lines: [...], choices: [{ key, label, primary }] });
//   k: the key picked, or null for Cancel

const ARM_MS = 600;

export function askWarning({ title, lines = [], choices = [] }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modalback warnask';
    const box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2');
    h.id = 'warnasktitle';
    h.textContent = title;
    box.setAttribute('aria-labelledby', h.id);
    box.appendChild(h);
    for (const l of lines) {
      const p = document.createElement('p');
      p.textContent = l;
      box.appendChild(p);
    }
    const row = document.createElement('div');
    row.className = 'row modalbtns';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    row.appendChild(cancel);
    const armedAt = Date.now() + ARM_MS;
    const btns = choices.map((c) => {
      const b = document.createElement('button');
      b.textContent = c.label;
      if (c.primary) b.className = 'primary';
      b.onclick = () => { if (Date.now() >= armedAt) done(c.key); };
      row.appendChild(b);
      return b;
    });
    box.appendChild(row);
    back.appendChild(box);
    const was = document.activeElement;
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      // focus stays in the dialog
      if (e.key === 'Tab') {
        const all = [cancel, ...btns];
        const i = all.indexOf(document.activeElement);
        e.preventDefault();
        all[(i + (e.shiftKey ? all.length - 1 : 1)) % all.length].focus();
      }
    };
    function done(k) {
      document.removeEventListener('keydown', key, true);
      back.remove();
      if (was && was.focus && document.contains(was)) was.focus();
      resolve(k);
    }
    cancel.onclick = () => done(null);
    document.addEventListener('keydown', key, true);
    document.body.appendChild(back);
    cancel.focus();
  });
}

// one is open: the hub holds its redraws meanwhile
export const warningOpen = () => !!document.querySelector('.warnask');

// "Room 2", "Room 2 and Room 4", "Room 2, Room 4 and Room 5"
export const andList = (xs) => (xs.length < 2 ? xs.join('')
  : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
