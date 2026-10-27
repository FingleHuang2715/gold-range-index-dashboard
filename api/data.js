const { handleApiData } = require('../dev');

module.exports = async function handler(req, res) {
  return handleApiData(req, res);
};
