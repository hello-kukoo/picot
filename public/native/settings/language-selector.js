import { getLanguagePreference, LANGUAGES, onLocaleChange, setLocale, t } from "../../i18n.js";
import { enhanceSelect } from "../../ui/select-menu.js";

export function setupLanguageSelector({ onChange } = {}) {
  const select = document.getElementById("settings-language-select");
  if (!select) return null;
  const menu = enhanceSelect(select);

  function render() {
    const current = getLanguagePreference();
    select.replaceChildren();
    for (const language of LANGUAGES) {
      const option = document.createElement("option");
      option.value = language.value;
      option.textContent = language.nativeLabel ?? t(language.labelKey);
      option.selected = current === language.value;
      select.append(option);
    }
  }

  async function handleChange() {
    select.disabled = true;
    try {
      await setLocale(select.value);
      render();
      onChange?.();
    } finally {
      select.disabled = false;
    }
  }

  select.addEventListener("change", handleChange);
  render();
  const unsubscribe = onLocaleChange(render);

  return {
    render,
    destroy() {
      unsubscribe();
      menu?.destroy();
    },
  };
}
