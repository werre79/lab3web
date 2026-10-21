#!/usr/bin/env node
import { Command, Argument, Help } from "commander";
import { readFileSync } from "node:fs";

// ---------- Допоміжні функції ----------

// Причини, з яких файл не вдається прочитати, за кодом помилки Node.js (українською).
const READ_ERROR_REASONS = {
  EISDIR: "це каталог, а не файл",
  EACCES: "немає прав доступу",
  EPERM: "операцію заборонено",
};

/** Друкує повідомлення про помилку українською та завершує програму з кодом 1. */
function fail(message) {
  console.error(`Помилка: ${message}`);
  process.exit(1);
}

/**
 * Зчитує та парсить JSON-файл розкладу. Усі типові проблеми (немає файлу,
 * некоректний JSON, неочікувана структура) завершуються зрозумілою
 * помилкою українською, а не стеком викликів.
 */
function loadData(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") fail(`файл "${filePath}" не знайдено.`);
    const reason = READ_ERROR_REASONS[err.code] ?? `код помилки ${err.code ?? "невідомий"}`;
    fail(`не вдалося прочитати файл "${filePath}" (${reason}).`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // Текст помилки JSON.parse англійський і залежить від версії Node, тому з нього
    // беремо лише позицію (є в усіх версіях), а пояснення формуємо самі.
    const position = err.message.match(/position (\d+)/)?.[1];
    const where = position ? ` (синтаксична помилка біля символу ${position})` : "";
    fail(`файл "${filePath}" містить некоректний JSON${where}.`);
  }

  // JSON може бути синтаксично правильним, але не бути розкладом (null, [], число...)
  const looksLikeSchedule =
    data !== null &&
    typeof data === "object" &&
    Array.isArray(data.days) &&
    data.days.every(
      (d) =>
        d !== null &&
        typeof d === "object" &&
        typeof d.dayOfWeek === "string" &&
        Array.isArray(d.lessons) &&
        d.lessons.every((l) => l !== null && typeof l === "object")
    );
  if (!looksLikeSchedule) {
    fail(
      `файл "${filePath}" має неочікувану структуру: потрібен об'єкт із масивом "days", ` +
        `де кожен день має рядок "dayOfWeek" і масив "lessons" з об'єктів-занять.`
    );
  }
  return data;
}

/** Повертає масив { dayOfWeek, lesson } для всіх занять документа (обхід вкладених масивів). */
function flattenLessons(data) {
  const result = [];
  for (const day of data.days) {
    for (const lesson of day.lessons) {
      result.push({ dayOfWeek: day.dayOfWeek, lesson });
    }
  }
  return result;
}

/** Короткий текстовий опис викладача: "доцент Бойко Я. В." або "не вказано". */
function teacherLabel(teacher) {
  if (teacher == null) return "не вказано";
  const rank = teacher.academicRank ? `${teacher.academicRank} ` : "";
  return `${rank}${teacher.fullName}`;
}

/** Один рядок стислого переліку заняття. */
function lessonSummaryLine({ dayOfWeek, lesson }) {
  const parity = lesson.weekParity ? ` [${lesson.weekParity}]` : "";
  const remote = lesson.isRemote ? " (дистанційно)" : "";
  return `${dayOfWeek}, пара ${lesson.pairNumber} (${lesson.time})${parity} — ${lesson.subject} (${lesson.lessonType})${remote}`;
}

/** Повний, багаторядковий опис одного заняття з усіма полями. */
function lessonFullText({ dayOfWeek, lesson }) {
  const lines = [
    `День: ${dayOfWeek}`,
    `Пара: ${lesson.pairNumber} (${lesson.time})`,
    `Підгрупа: ${lesson.subgroup ?? "не вказано (null)"}`,
    `Дисципліна: ${lesson.subject}`,
    `Тип заняття: ${lesson.lessonType}`,
    `Викладач: ${teacherLabel(lesson.teacher)}`,
    `Аудиторія: ${lesson.room}`,
    `Дистанційно: ${lesson.isRemote ? "так" : "ні"}`,
    `Тиждень: ${lesson.weekParity ?? "щотижня (null)"}`,
  ];
  if ("department" in lesson) lines.push(`Кафедра: ${lesson.department}`);
  if ("note" in lesson) lines.push(`Примітка: ${lesson.note}`);
  return lines.join("\n");
}

/** Нормалізує текст для порівняння: нижній регістр, єдиний вигляд апострофа. */
function normalize(text) {
  return text.toLowerCase().replace(/[\u2019\u02bc`]/g, "'");
}

/** Знаходить день за назвою (без урахування регістру й виду апострофа). */
function findDay(data, dayName) {
  const day = data.days.find((d) => normalize(d.dayOfWeek) === normalize(dayName));
  if (!day) {
    const available = data.days.map((d) => d.dayOfWeek).join(", ");
    fail(`день "${dayName}" не знайдено в розкладі. Доступні дні: ${available}.`);
  }
  return day;
}

/**
 * Знаходить заняття за днем тижня й номером пари. Якщо на цю пару припадає
 * кілька занять (чергування за weekParity), а parity не вказано — повертає
 * усі знайдені записи; рішення, що з ними робити, ухвалює resolveSingleLesson.
 */
function findLessons(data, dayName, pairNumber, parity) {
  const day = findDay(data, dayName);
  let matches = day.lessons.filter((l) => l.pairNumber === pairNumber);
  if (matches.length === 0) {
    fail(`пару №${pairNumber} не знайдено в дні "${day.dayOfWeek}".`);
  }
  if (parity) {
    matches = matches.filter((l) => l.weekParity === parity);
    if (matches.length === 0) {
      fail(`на пару №${pairNumber} у дні "${day.dayOfWeek}" з тижнем "${parity}" нічого не знайдено.`);
    }
  }
  return matches.map((lesson) => ({ dayOfWeek: day.dayOfWeek, lesson }));
}

/**
 * Повертає рівно одне заняття для команд show і field. Якщо під описом
 * підпадає кілька (чергування чисельник/знаменник) — це помилка виклику:
 * користувач має уточнити тиждень третім аргументом.
 */
function resolveSingleLesson(data, dayName, pair, parity) {
  const pairNumber = parsePositiveInt(pair, "номер пари");
  const matches = findLessons(data, dayName, pairNumber, parity);
  if (matches.length > 1) {
    const options = matches.map((m) => "  " + lessonSummaryLine(m)).join("\n");
    fail(
      `у дні "${matches[0].dayOfWeek}" на пару №${pairNumber} припадає ${matches.length} заняття залежно від тижня. ` +
        `Уточніть тиждень (чисельник або знаменник) останнім аргументом:\n${options}`
    );
  }
  return matches[0];
}

/**
 * Читає значення поля за шляхом через крапку (підтримує вкладені об'єкти).
 * Явно розрізняє три випадки, щоб повідомлення про помилку було точним:
 *  - found: true          — поле знайдено (значення може бути й null);
 *  - reason: "missing"    — на цьому кроці шляху такого ключа немає;
 *  - reason: "null-parent"— проміжний об'єкт дорівнює null, тому спускатися
 *                           далі по шляху неможливо (напр. teacher.academicRank,
 *                           коли сам teacher — null).
 */
function getByPath(obj, path) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (current === null) {
      return { found: false, reason: "null-parent", atPart: parts.slice(0, i).join(".") };
    }
    if (typeof current !== "object" || !(part in current)) {
      return { found: false, reason: "missing", atPart: parts.slice(0, i + 1).join(".") };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

/** Форматує значення поля для виводу: об'єкти — у вигляді JSON, null — рядком "null". */
function formatFieldValue(value) {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** Перетворює рядок на додатне ціле число; label — що саме перевіряємо (для повідомлення). */
function parsePositiveInt(value, label) {
  if (!/^\d+$/.test(value) || Number(value) === 0) {
    fail(`${label} має бути додатним цілим числом, отримано "${value}".`);
  }
  return Number(value);
}

// ---------- Опис програми ----------

const DEFAULT_FILE = "data.json";

// Службові заголовки довідки commander за замовчуванням англійські — перекладаємо їх.
const HELP_TITLES = {
  "Usage:": "Використання:",
  "Arguments:": "Аргументи:",
  "Options:": "Опції:",
  "Commands:": "Команди:",
};
const defaultHelp = new Help();
const helpLocalization = {
  styleTitle: (text) => HELP_TITLES[text] ?? text,
  // "[options]" у рядках використання команд теж замінюємо на українське "[опції]"
  commandUsage: (cmd) => defaultHelp.commandUsage(cmd).replace("[options]", "[опції]"),
  subcommandTerm: (cmd) => defaultHelp.subcommandTerm(cmd).replace("[options]", "[опції]"),
  // замість "(choices: ...)" показуємо "(допустимі значення: ...)"
  argumentDescription: (argument) =>
    argument.argChoices
      ? `${argument.description} (допустимі значення: ${argument.argChoices.join(", ")})`
      : argument.description,
};

/** Читає розклад із файлу, заданого глобальною опцією --file (або з файлу за замовчуванням). */
function loadScheduleFromOptions() {
  return loadData(program.opts().file ?? DEFAULT_FILE);
}

const program = new Command();

program
  .name("schedule-cli")
  .description(
    "CLI-програма для роботи з розкладом занять групи (JSON-документ з ЛР1)."
  )
  .version("1.0.0", "-v, --version", "показати версію програми")
  .option("-f, --file <path>", `шлях до JSON-файлу розкладу (за замовчуванням: ${DEFAULT_FILE})`)
  .usage("[опції] [команда]")
  .configureHelp(helpLocalization)
  .helpOption("-h, --help", "показати довідку")
  .addHelpCommand("help [command]", "показати довідку по команді")
  .addHelpText(
    "after",
    `
Приклади:
  $ node index.js list --limit 5
  $ node index.js show Понеділок 1
  $ node index.js field Понеділок 1 teacher.academicRank
  $ node index.js day Вівторок
  $ node index.js teacher Бойко --remote-only
  $ node index.js parity чисельник`
  )
  // commander сам друкує свої помилки англійською — вимикаємо це, бо ми виводимо
  // власне повідомлення українською в блоці catch унизу файлу.
  .configureOutput({ outputError: () => {} })
  // exitOverride: замість process.exit commander кидає виняток, який ми перехоплюємо.
  .exitOverride();

// ---------- Частина 3. Загальні можливості ----------

program
  .command("list")
  .description("показати стислий перелік занять")
  .option("-l, --limit <n>", "обмежити кількість виведених занять", (v) => parsePositiveInt(v, "значення опції --limit"))
  .action((opts) => {
    const data = loadScheduleFromOptions();
    let items = flattenLessons(data);
    if (opts.limit) items = items.slice(0, opts.limit);
    if (items.length === 0) {
      console.log("Заняття не знайдено.");
      return;
    }
    console.log(`Розклад групи ${data.groupName}, ${data.subgroup}:`);
    items.forEach((item) => console.log("  " + lessonSummaryLine(item)));
  });

program
  .command("show")
  .description("показати одне заняття цілком")
  .addArgument(new Argument("<day>", "день тижня, напр. Понеділок"))
  .addArgument(new Argument("<pair>", "номер пари"))
  .addArgument(
    new Argument("[parity]", "тиждень, якщо на пару припадає кілька занять").choices([
      "чисельник",
      "знаменник",
    ])
  )
  .action((day, pair, parity) => {
    const data = loadScheduleFromOptions();
    console.log(lessonFullText(resolveSingleLesson(data, day, pair, parity)));
  });

program
  .command("field")
  .description("показати значення окремого поля заняття (підтримує вкладені поля через крапку)")
  .addArgument(new Argument("<day>", "день тижня"))
  .addArgument(new Argument("<pair>", "номер пари"))
  .addArgument(new Argument("<path>", "шлях до поля, напр. teacher.academicRank"))
  .addArgument(
    new Argument("[parity]", "тиждень, якщо на пару припадає кілька занять").choices([
      "чисельник",
      "знаменник",
    ])
  )
  .action((day, pair, path, parity) => {
    const data = loadScheduleFromOptions();
    const { lesson } = resolveSingleLesson(data, day, pair, parity);
    const result = getByPath(lesson, path);
    if (!result.found) {
      if (result.reason === "null-parent") {
        fail(
          `неможливо отримати "${path}": проміжне поле "${result.atPart}" має значення null, тому вкладених полів у ньому немає.`
        );
      }
      fail(`поле "${result.atPart}" відсутнє в цьому занятті.`);
    }
    console.log(formatFieldValue(result.value));
  });

// ---------- Частина 4. Можливості варіанта (розклад занять) ----------

program
  .command("day")
  .description("показати всі заняття обраного дня тижня")
  .addArgument(new Argument("<dayOfWeek>", "день тижня, напр. Вівторок (регістр не важливий)"))
  .action((dayName) => {
    const data = loadScheduleFromOptions();
    const day = findDay(data, dayName);
    console.log(`Розклад дня: ${day.dayOfWeek} (всього занять: ${day.lessons.length}):`);
    day.lessons.forEach((lesson) =>
      console.log("  " + lessonSummaryLine({ dayOfWeek: day.dayOfWeek, lesson }))
    );
  });

program
  .command("teacher")
  .description("показати заняття обраного викладача (частковий пошук за іменем)")
  .addArgument(new Argument("<name>", "повне ім'я або фрагмент, напр. Бойко"))
  .option("--remote-only", "показати лише дистанційні заняття")
  .action((name, opts) => {
    const data = loadScheduleFromOptions();
    const needle = normalize(name);
    let items = flattenLessons(data).filter(
      (item) =>
        typeof item.lesson.teacher?.fullName === "string" &&
        normalize(item.lesson.teacher.fullName).includes(needle)
    );
    if (opts.remoteOnly) {
      items = items.filter((item) => item.lesson.isRemote);
    }
    if (items.length === 0) {
      console.log(`Заняття викладача "${name}" не знайдено${opts.remoteOnly ? " (серед дистанційних)" : ""}.`);
      return;
    }
    console.log(`Заняття викладача "${name}" (всього: ${items.length}):`);
    items.forEach((item) => console.log("  " + lessonSummaryLine(item)));
  });

program
  .command("parity")
  .description("показати розклад за чисельником або знаменником (разом із щотижневими заняттями)")
  .addArgument(new Argument("<value>", "тиждень").choices(["чисельник", "знаменник"]))
  .action((value) => {
    const data = loadScheduleFromOptions();
    // щотижневі заняття (weekParity === null) входять в обидва варіанти тижня
    const items = flattenLessons(data).filter(
      (item) => item.lesson.weekParity === value || item.lesson.weekParity === null
    );
    console.log(`Розклад на тиждень "${value}" (всього: ${items.length}, разом із щотижневими):`);
    items.forEach((item) => console.log("  " + lessonSummaryLine(item)));
  });

// ---------- Запуск програми з перехопленням помилок commander ----------

/**
 * Формує повідомлення українською за кодом помилки commander. Самі коди стабільні
 * (частина публічного API), а англійський текст повідомлення лише розбираємо,
 * щоб дістати з нього назву опції/аргументу; якщо розібрати не вдалося — загальна фраза.
 */
function describeCommanderError(err) {
  const msg = err.message.replace(/^error: /, "");
  const grab = (re) => msg.match(re) ?? [];

  switch (err.code) {
    case "commander.missingArgument": {
      const [, name] = grab(/argument '([^']+)'/);
      return name ? `пропущено обов'язковий аргумент <${name}>.` : "пропущено обов'язковий аргумент.";
    }
    case "commander.optionMissingArgument": {
      const [, opt] = grab(/option '([^']+)'/);
      return opt ? `для опції "${opt}" не вказано значення.` : "для опції не вказано значення.";
    }
    case "commander.unknownOption": {
      const [, opt] = grab(/unknown option '([^']+)'/);
      return opt ? `невідома опція "${opt}".` : "невідома опція.";
    }
    case "commander.unknownCommand": {
      const [, name] = grab(/unknown command '([^']+)'/);
      return name ? `невідома команда "${name}".` : "невідома команда.";
    }
    case "commander.excessArguments": {
      const [, cmd, expected, got] = grab(/too many arguments for '([^']+)'\. Expected (\d+) arguments? but got (\d+)/);
      return cmd
        ? `забагато аргументів для "${cmd}": очікувалось ${expected}, отримано ${got}.`
        : "забагато аргументів.";
    }
    case "commander.invalidArgument": {
      const [, value, name, choices] = grab(/value '([^']*)' is invalid for argument '([^']+)'(?:\. Allowed choices are (.+?)\.?)?$/);
      if (!name) return "неприпустиме значення аргументу.";
      return choices
        ? `значення "${value}" неприпустиме для аргументу <${name}>. Допустимі значення: ${choices}.`
        : `значення "${value}" неприпустиме для аргументу <${name}>.`;
    }
    default:
      return "некоректний виклик програми.";
  }
}

try {
  program.parse(process.argv);
} catch (err) {
  // Власні помилки (fail()) уже викликали process.exit(1) до цього блоку.
  // Сюди потрапляють лише помилки самого commander: невідома команда/опція,
  // пропущений обов'язковий аргумент, неприпустиме значення аргументу тощо.
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
    process.exit(0);
  }
  // Програму запущено без команди: commander уже показав довідку, додаткове повідомлення зайве.
  if (err.code === "commander.help") {
    process.exit(err.exitCode ?? 1);
  }
  if (typeof err.code === "string" && err.code.startsWith("commander.")) {
    console.error(`Помилка: ${describeCommanderError(err)}`);
    console.error("Довідка: node index.js --help");
    process.exit(err.exitCode && err.exitCode !== 0 ? err.exitCode : 1);
  }
  // Усе інше — непередбачена помилка виконання; стек не показуємо.
  console.error(`Помилка: сталася непередбачена помилка під час виконання (${err.message}).`);
  process.exit(1);
}
