const { handleApiMt4 } = require('../server');

module.exports = async function handler(req, res) {
  return handleApiMt4(req, res);
};
