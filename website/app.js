const menuButton = document.querySelector("[data-menu-toggle]");
const navigation = document.querySelector("[data-site-nav]");
const header = document.querySelector("[data-site-header]");
const menuLabel = document.querySelector("[data-menu-label]");

function closeMenu() {
  menuButton?.setAttribute("aria-expanded", "false");
  navigation?.removeAttribute("data-open");
  if (menuLabel) menuLabel.textContent = "Open navigation";
}

menuButton?.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!open));
  navigation?.toggleAttribute("data-open", !open);
  if (menuLabel) menuLabel.textContent = open ? "Open navigation" : "Close navigation";
});

navigation?.addEventListener("click", (event) => {
  if (event.target instanceof HTMLAnchorElement) closeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

const updateHeader = () => header?.toggleAttribute("data-scrolled", window.scrollY > 12);
window.addEventListener("scroll", updateHeader, { passive: true });
updateHeader();

for (const year of document.querySelectorAll("[data-year]")) {
  year.textContent = String(new Date().getFullYear());
}
