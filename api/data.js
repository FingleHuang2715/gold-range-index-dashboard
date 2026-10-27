const { handleApiData } = require('../server');

module.exports = async function handler(req, res) {
  return handleApiData(req, res);
};
