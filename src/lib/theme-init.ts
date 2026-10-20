// Shared by the root layout (server) and the theme hooks (client). Kept free of
// React so the layout can inline the script without a client boundary.

export const THEME_KEY = "bos-theme";

// Runs inline in <head> before paint, so a stored choice never flashes. With
// nothing stored the page follows the system through prefers-color-scheme.
export const themeInitScript = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
