export const PANEL_THEMES=Object.freeze({
    dark:{name:'Ночная книга',art:'Линии омута',image:'header_night.jpg'},
    ice:{name:'Ледяной омут',art:'Спираль памяти',image:'header_ice.jpg'},
    light:{name:'Светлый архив',art:'Отражение',image:'header_light.jpg'},
});

// Dark and light retain the identifiers used by existing settings and backups.
export const panelTheme=value=>Object.hasOwn(PANEL_THEMES,value)?value:'dark';
