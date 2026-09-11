'use strict';

function matchesQuery(value, query) {
  if (typeof value !== 'string') return false;
  if (!(query instanceof RegExp)) return value.includes(query);
  query.lastIndex = 0;
  return query.test(value);
}

module.exports = matchesQuery;
