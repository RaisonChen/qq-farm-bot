function timestamp() {
  return new Date().toISOString();
}

function format(level, message, meta) {
  const base = `${timestamp()} [${level}] ${message}`;
  if (meta && Object.keys(meta).length) {
    try {
      return `${base} ${JSON.stringify(meta)}`;
    } catch {
      return base;
    }
  }
  return base;
}

const logger = {
  info(message, meta) {
    console.log(format("INFO", message, meta));
  },
  warn(message, meta) {
    console.warn(format("WARN", message, meta));
  },
  error(message, meta) {
    console.error(format("ERROR", message, meta));
  },
};

module.exports = { logger };
