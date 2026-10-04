import { indiaDateKey } from './session-profile.js';

const contractPatterns = {
  NIFTY: /^NIFTY\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{2}\s+FUT$/i,
  SENSEX: /^SENSEX\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{2}\s+FUT$/i
};

function configuredExpiry(symbol) {
  const match = /(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)FUT$/i.exec(symbol || '');
  if (!match) return null;
  return `${match[1]} ${match[2].toUpperCase()} (contract expiry date not in symbol)`;
}

export function selectFuturesContract(records, instrument, configuredSymbol = '', now = Date.now()) {
  const pattern = contractPatterns[instrument];
  if (!pattern) throw new TypeError(`Unsupported futures instrument: ${instrument}`);

  const contracts = records
    .filter((record) => pattern.test(String(record[1] || '').trim()))
    .map((record) => ({
      symbol: String(record[9] || '').trim(),
      description: String(record[1] || '').trim(),
      expiryTimestamp: Number(record[8]) * 1000,
      tickSize: Number(record[4])
    }))
    .filter((contract) => contract.symbol && Number.isFinite(contract.expiryTimestamp))
    .sort((left, right) => left.expiryTimestamp - right.expiryTimestamp);

  const configuredContract = contracts.find((contract) => contract.symbol === configuredSymbol
    && contract.expiryTimestamp > now);
  const selected = configuredContract || contracts.find((contract) => contract.expiryTimestamp > now);

  if (!selected) {
    if (configuredSymbol && !contracts.some((contract) => contract.symbol === configuredSymbol)) {
      return {
        symbol: configuredSymbol,
        description: configuredSymbol,
        expiryDate: null,
        expiryLabel: configuredExpiry(configuredSymbol),
        expiryTimestamp: null,
        tickSize: null,
        expired: null,
        source: 'CONFIGURED_SYMBOL'
      };
    }
    throw new Error(`No active ${instrument} futures contract found`);
  }

  const expiryDate = indiaDateKey(new Date(selected.expiryTimestamp));
  return {
    ...selected,
    expiryDate,
    expiryLabel: new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata'
    }).format(new Date(selected.expiryTimestamp)),
    expired: selected.expiryTimestamp <= now,
    source: selected === configuredContract ? 'CONFIGURED_SYMBOL' : 'NEAREST_EXPIRY'
  };
}
