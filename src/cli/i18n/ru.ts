/**
 * The Russian message catalog. Compiler-forced to cover every key of the
 * English catalog (`Catalog = typeof en`); command/flag names, FQNs, and
 * other copy-pasteable tokens inside values stay verbatim.
 */
import type { Catalog } from "./en.js";

export const ru: Catalog = {
  // -- program and global flags ---------------------------------------------
  "cli.description": "доступ к исходникам зависимостей для AI-агентов в JVM-проектах",
  "opt.json": "машиночитаемый вывод (тот же объект, что возвращает MCP)",
  "opt.project": "корень проекта (по умолчанию: cwd)",
  "opt.buildTool":
    "кто выполняет разрешение зависимостей (mvn/gradle): системный инструмент из PATH, wrapper из корня проекта или сначала системный с откатом на wrapper (по умолчанию)",
  "opt.lang": "язык интерфейса для человекочитаемого вывода (en, ru)",

  // -- subcommand descriptions ------------------------------------------------
  "cmd.find-class": "поиск классов по FQN, суффиксу, простому имени или нечёткому совпадению",
  "cmd.outline":
    "скелет класса в стиле Java (пресеты + переключатели секций; --table — прежнее табличное представление)",
  "cmd.read-member": "фрагменты исходника по селекторам членов (#name, #name(T1,T2))",
  "cmd.read-source": "исходный текст одного класса (outline | full | lines)",
  "cmd.read-resource": "неклассовые записи jar (конфиги, сервисы, манифесты)",
  "cmd.search-symbols": "поиск объявлений по имени члена в одном артефакте",
  "cmd.resolve": "принудительный проход разрешения зависимостей",
  "cmd.status": "отчёт по манифесту и JVM",
  "cmd.where": "пути на диске для одного артефакта",
  "cmd.mcp": "запустить stdio MCP-сервер для этого проекта",
  "cmd.prime": "шпаргалка jarpeek для агентов (этот файл)",
  "cmd.init": "настроить AI-харнесы (MCP-сервер или CLI-подсказки) для этого проекта",

  // -- per-command option help -------------------------------------------------
  "opt.kind": "фильтр по типу объявления",
  "opt.visibility": "фильтр по видимости",
  "opt.minimal": "пресет: без импортов, полей и javadoc",
  "opt.fullOutline": "пресет: всё — блоки javadoc и маркеры тел методов",
  "opt.imports": "показать импорты (переопределяет пресет)",
  "opt.noImports": "скрыть импорты (переопределяет пресет)",
  "opt.fields": "показать поля/свойства/константы перечислений (переопределяет пресет)",
  "opt.noFields": "скрыть поля/свойства/константы перечислений (переопределяет пресет)",
  "opt.methods": "показать методы/конструкторы (переопределяет пресет)",
  "opt.noMethods": "скрыть методы/конструкторы (переопределяет пресет)",
  "opt.inner": "показать вложенные классы (переопределяет пресет)",
  "opt.noInner": "скрыть вложенные классы (переопределяет пресет)",
  "opt.javadoc": "показать javadoc (переопределяет пресет)",
  "opt.noJavadoc": "скрыть javadoc (переопределяет пресет)",
  "opt.table": "прежнее табличное представление тех же строк",
  "opt.limitHits": "максимум совпадений",
  "opt.limitRows": "максимум строк",
  "opt.fullFile": "весь файл",
  "opt.lines": "диапазон строк, напр. 2:3",
  "opt.artifact": "координаты g:a:v или уникальный id артефакта",
  "opt.primeFull": "полная cli-шпаргалка (по умолчанию без привязки MCP)",
  "opt.primeMcp": "короткая mcp-карточка",
  "opt.primeExport": "стандартное содержимое, даже если есть .jarpeek/PRIME.md",
  "opt.primeHookJson": "обернуть текст как additionalContext-нагрузку хука SessionStart",
  "opt.yes": "без интерактива: claude + mcp по умолчанию",

  // -- help-block prose ----------------------------------------------------------
  "help.frugal":
    "экономный путь: find-class находит класс, outline показывает его устройство, read-member даёт код конкретного члена — read-source нужен только для файла целиком.",
  "help.examples": "Примеры:",
  "help.related": "связанное:",
  "help.primePointer": "полная шпаргалка для агентов: jarpeek prime --full",
  "help.mcp":
    "обслуживает stdio MCP-сервер; jarpeek init пишет конфиги харнесов, которые его запускают.",
  "help.prime":
    "--full даёт полную шпаргалку для агентов; --export обходит переопределение через .jarpeek/PRIME.md.",
  "help.init": "настройка без интерактива (Claude Code + MCP).",

  // -- related: cross-link sentences ----------------------------------------------
  "related.find-class": "outline <fqn> показывает устройство найденного класса.",
  "related.outline":
    "read-member возвращает код одного члена; --table сохраняет прежнее табличное представление.",
  "related.read-member": "read-source --lines a:b — окружающий контекст.",
  "related.read-source": "сначала дешевле — outline, затем read-member.",
  "related.read-resource": "where <coords> — пути артефакта на диске.",
  "related.search-symbols": "find-class, когда неизвестно, в каком артефакте лежит класс.",
  "related.resolve": "status показывает, что теперь находится в манифесте.",
  "related.status": "resolve запускает повторное разрешение.",
  "related.where": "read-resource читает неклассовые записи того же артефакта.",

  // -- runtime: the warning channel (plural families feed choose()) ----------------
  "warn.prefix": "предупреждение",
  "warn.more.one": "ещё {n} предупреждение (см. jarpeek status)",
  "warn.more.few": "ещё {n} предупреждения (см. jarpeek status)",
  "warn.more.many": "ещё {n} предупреждений (см. jarpeek status)",
  "warn.more.other": "ещё {n} предупреждений (см. jarpeek status)",

  // -- runtime: miss-protocol rendering ----------------------------------------------
  "miss.fuzzy": "нет индексированного класса для {label}; возможно, вы имели в виду:",
  "miss.searched": "просмотрено:",
  "miss.none": "(нет)",

  // -- runtime: usage errors ------------------------------------------------------------
  "err.lines.format": "--lines ожидает from:to (напр. 2:3), получено \"{value}\"",
  "err.lines.range": "--lines ожидает from:to с нумерацией от 1 и to >= from, получено \"{value}\"",
  "err.positiveInt": "ожидается целое положительное число, получено \"{value}\"",
  "err.exclusive.minFull": "--minimal и --full взаимоисключающие",
  "err.exclusive.fullLines": "--full и --lines взаимоисключающие",
  "err.unknownCommand":
    "неизвестная команда '{name}' — возможно, вы имели в виду '{suggestion}'? (см. jarpeek --help)",
  "err.unknownCommandPlain": "неизвестная команда '{name}' (см. jarpeek --help)",
  "err.fatal": "ошибка",
  // -- runtime: human renderers -------------------------------------------
  "render.spanLines": "строки {a}–{b}",
  "render.signatureOnly": "только сигнатура",
  "render.memberHeader": "{fqn}#{selector}  ({span}  происхождение {provenance})",
  "render.miss": "не найдено {selector}: {reason}",
  "render.alternative": "альтернатива: {coords}",
  "render.fileHeader": "файл {file}, происхождение {provenance}",
  "render.linesFull": "строки 1-{n}",
  "render.linesOf": "строки {a}–{b} из {n}",
  "render.clamped": " (усечено)",
  "render.artifactHeader": "артефакт {artifact}, происхождение {provenance}",
  "render.noEntries": "артефакт {artifact}: нет подходящих записей (происхождение {provenance})",
  "render.noSymbols": "символы по запросу {query} не найдены",
  "render.resolved.one": "разрешен {n} артефакт за {ms} мс",
  "render.resolved.few": "разрешено {n} артефакта за {ms} мс",
  "render.resolved.many": "разрешено {n} артефактов за {ms} мс",
  "render.resolved.other": "разрешено {n} артефактов за {ms} мс",
  "render.warningsSuffix.one": " ({w} предупреждение)",
  "render.warningsSuffix.few": " ({w} предупреждения)",
  "render.warningsSuffix.many": " ({w} предупреждений)",
  "render.warningsSuffix.other": " ({w} предупреждений)",
  "render.moreLine": "+{n} ещё (см. jarpeek status)",
  "render.coordinates": "координаты {coords}",
  "render.exists": "(существует)",
  "render.missing": "(отсутствует)",
  "render.buildSystems": "системы сборки: {list}",
  "render.none": "(нет)",
  "render.notDetected": "(не найден)",
  "render.wired": "настроено {harness} ({mode}): {targets}",
  "render.note": "примечание: {note}",
  "render.outlineTable": "{fqn}  {coords}  происхождение {provenance}",

  // -- skeleton view (outline's default; --table uses render.outlineTable) --
  "skeleton.header": "{coords}  происхождение {provenance}",
  "skeleton.stale": "подан устаревший индекс",
};
