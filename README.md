# al-id-libre

Mod de Claude Code para proyectos AL de Business Central. Detecta los objetos nuevos que no tienen ID (o tienen uno repetido) y propone el siguiente ID libre. Para elegirlo revisa todas las ramas de git, locales y remotas, y los cambios sin commit.

## Qué hace

- **Detecta solo.** Cada 5 segundos mira los `.al` nuevos o modificados (`git status`). Si un objeto tiene `Id`, `0`, ningún ID, un ID repetido o un ID fuera de rango, avisa con una notificación y una línea en la conversación. El aviso incluye el ID propuesto.
- **Respeta tus rangos.** Lee `idRanges` de `app.json` y las descripciones de `.objidconfig` o los comentarios (`// ---- Saas ----`). Junta en un grupo los rangos con el mismo nombre (`OnPrem1` y `OnPrem2` → `OnPrem`).
- **Entiende `#if OnPrem … #else … #endif`.** La declaración que está dentro de `#if OnPrem` recibe un ID del rango OnPrem y la del `#else`, uno del otro rango.
- **`/asignar-id`** escribe los IDs propuestos en los archivos.
- **`/id-libre [tipo]`** muestra el siguiente ID libre por tipo y por rango. También avisa de los IDs que ya comparten objetos distintos en las ramas.
- **Claude también lo sabe.** Tiene la herramienta `id_libre` para elegir IDs cuando crea objetos. Si escribe un `.al` sin ID válido, el mod le dice cuál usar.

Los objetos que ya existen en alguna rama nunca se renumeran: solo se avisa.

El ID propuesto es el siguiente al más alto que se usa en ese rango. Los huecos que quedan por debajo (por ejemplo, de objetos borrados) solo se usan cuando el rango está lleno por arriba. Así no se reutiliza el ID de una tabla borrada que todavía puede existir en algún entorno.

## Límites

- No reserva IDs: solo ve lo que está en tus ramas (después de un `git fetch`) y en tus archivos. Si un compañero no ha subido su rama, no la verá.
- Solo asigna IDs de objetos, no de campos ni de valores de enum.

## Opciones

Se cambian en el menú de configuración de Claude Code o en `~/.claude/settings.json`, en `"pluginConfigs": { "al-id-libre@inline": { "options": { ... } } }`:

- `intervalSeconds` (5): cada cuántos segundos busca objetos sin ID.
- `fetch` (true): ejecuta `git fetch --all` al empezar, cada 10 minutos y antes de `/asignar-id` e `/id-libre`.

## Instalación

Este mod se carga desde la variable `CLAUDE_CODE_PLUGIN_DIRS` en `~/.claude/settings.json`. Después de cambiarla, abre una sesión nueva de Claude Code.

Pruebas: `claude plugin test` en esta carpeta.
