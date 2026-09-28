// busy.js — the dashboard's loading state. The button that started an
// action becomes its progress: disabled, a spinner, and what it's doing
// ("Creating rooms… 3 of 8" when there are several steps). A thin bar
// under the button's row fills as the steps land. The other buttons in
// `scope` wait until it's done, so nothing is sent twice.

/**
 * @param btn    the button pressed
 * @param opts   {label, total, scope}: total > 1 counts and shows the bar
 * @returns      {step(done), end()} — step() after each finished step;
 *               end() always (finally), restoring whatever is still on
 *               screen (a redraw may already have replaced it all)
 */
export function busy(btn, { label, total = 0, scope = null } = {}) {
  const idleHtml = btn.innerHTML;
  const locked = scope
    ? [...scope.querySelectorAll('button')].filter((b) => b !== btn && !b.disabled) : [];
  for (const b of locked) b.disabled = true;
  let bar = null;
  if (total > 1) {
    bar = document.createElement('div');
    bar.className = 'busybar';
    bar.innerHTML = '<i></i>';
    (btn.closest('.row') || btn).after(bar);
  }
  const text = document.createElement('span');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = '<span class="spin" aria-hidden="true"></span>';
  btn.appendChild(text);
  const show = (n) => { text.textContent = total > 1 ? `${label}… ${n} of ${total}` : `${label}…`; };
  show(1);
  return {
    step(done) {
      if (bar) bar.firstChild.style.width = Math.round((done / total) * 100) + '%';
      if (done < total) show(done + 1);
    },
    end() {
      if (bar) bar.remove();
      btn.classList.remove('busy');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      btn.innerHTML = idleHtml;
      for (const b of locked) b.disabled = false;
    },
  };
}
