import farmOS from 'farmos';
import makeLog from '@/utils/makeLog';

const farm = () => {
  const host = localStorage.getItem('host');
  const user = localStorage.getItem('username');
  const password = localStorage.getItem('password');
  return farmOS(host, user, password);
};

// Extend Error so we can propagate more info to the error handler
class SyncError extends Error {
  constructor({
    indices = [],
    http,
  } = {}, ...params) {
    // Pass remaining arguments (including vendor specific ones) to parent constructor
    super(...params);

    this.name = 'SyncError';
    // Custom debugging information
    this.indices = indices;
    this.http = http;
  }
}

export default {
  actions: {
    updateAreas({ commit }) {
      return farm().area.get().then((res) => {
        // If a successful response is received, delete and replace all areas
        commit('deleteAllAreas');
        const areas = res.list.map(({ tid, name, geofield }) => ({ tid, name, geofield })); // eslint-disable-line camelcase, max-len
        commit('addAreas', areas);
      });
    },
    updateAssets({ commit }) {
      return farm().asset.get().then((res) => {
        // If a successful response is received, delete and replace all assets
        commit('deleteAllAssets');
        const assets = res.list.map(({ id, name, type }) => ({ id, name, type }));
        commit('addAssets', assets);
      });
    },
    updateUnits({ commit }) {
      // Return units only.
      return farm().term.get('farm_quantity_units').then((res) => {
        commit('deleteAllUnits');
        const units = res.list.map(({ tid, name }) => ({ tid, name }));
        commit('addUnits', units);
      });
    },
    updateCategories({ commit }) {
      // Return categories only.
      return farm().term.get('farm_log_categories').then((res) => {
        commit('deleteAllCategories');
        const cats = res.list.map(({ tid, name }) => ({ tid, name }));
        commit('addCategories', cats);
      });
    },
    updateEquipment({ commit }) {
      function getEquip(assets) {
        const equip = [];
        assets.forEach((asset) => {
          if (asset.type === 'equipment') {
            equip.push(asset);
          }
        });
        return equip;
      }
      return farm().asset.get().then((res) => {
        commit('deleteAllEquipment');
        const assets = res.list.map(({ id, name, type }) => ({ id, name, type })); // eslint-disable-line camelcase, max-len
        const equipment = getEquip(assets);
        commit('addEquipment', equipment);
      });
    },

    // SEND LOGS TO SERVER (step 2 of sync)
    sendLogs({ commit, rootState }, indices) {
      // Update logs in the database and local store after send completes
      function handleSyncResponse(response, index) {
        commit('updateLogs', {
          indices: [index],
          mapper(log) {
            return makeLog.create({
              ...log,
              id: response.id,
              wasPushedToServer: true,
              isReadyToSync: false,
              remoteUri: response.uri,
            });
          },
        });
      }

      indices.forEach((index) => { // eslint-disable-line array-callback-return, max-len
        // Either send or post logs, depending on whether they originated on the server
        // Logs originating on the server possess an ID field; others do not.
        const newLog = makeLog.toServer(rootState.farm.logs[index]);
        farm().log.send(newLog, localStorage.getItem('token')) // eslint-disable-line no-use-before-define, max-len
          .then(res => handleSyncResponse(res, index))
          // .catch(err => handleSyncError(err, index, rootState, payload.router, commit));
          .catch((err) => {
            throw new SyncError({
              indices: [index],
              http: err,
            });
          });
      });
    },

    // GET LOGS FROM SERVER (step 1 of sync)
    getServerLogs({ commit, rootState }) {
      const syncDate = localStorage.getItem('syncDate');
      const allLogs = rootState.farm.logs;
      return farm().log.get(rootState.shell.settings.logImportFilters)
        .then(res => (
          // Returns an array of ids which have already been checked & merged
          res.list.map((log) => {
            const checkStatus = checkLog(log, allLogs, syncDate); // eslint-disable-line no-use-before-define, max-len
            if (checkStatus.serverChange) {
              const mergedLog = processLog(log, checkStatus, syncDate); // eslint-disable-line no-use-before-define, max-len
              commit('updateLogFromServer', {
                index: checkStatus.storeIndex,
                log: mergedLog,
              });
            }
            if (checkStatus.localId === null) {
              const mergedLog = processLog(log, checkStatus, syncDate); // eslint-disable-line no-use-before-define, max-len
              commit('addLogFromServer', mergedLog);
            }
            return log.id;
          })
        ))
        // Run a 2nd request for the remaining logs not included in the import filters
        .then((checkedIds) => {
          const uncheckedIds = allLogs
            .filter(log => log.id && !checkedIds.some(checkedId => log.id === checkedId))
            .map(log => log.id);
          return farm().log.get(uncheckedIds);
        })
        .then((res) => {
          res.list.forEach((log) => {
            const checkStatus = checkLog(log, allLogs, syncDate); // eslint-disable-line no-use-before-define, max-len
            if (checkStatus.serverChange) {
              const mergedLog = processLog(log, checkStatus, syncDate); // eslint-disable-line no-use-before-define, max-len
              commit('updateLogFromServer', {
                index: checkStatus.storeIndex,
                log: mergedLog,
              });
            }
          });
        })
        .catch((err) => {
          throw new SyncError({
            http: err,
          });
        });
    },
    // Stop spinner on aborted sync attempts by setting isReadyToSync false
    unreadyLog({ commit }, index) {
      commit('updateLogs', {
        indices: [index],
        mapper(log) {
          return makeLog.create({
            ...log,
            isReadyToSync: false,
          });
        },
      });
    },
  },
};

function checkLog(serverLog, allLogs, syncDate) {
  // The localLog will be passed as logStatus.log if localChange checks true
  const logStatus = {
    localId: null,
    storeIndex: null,
    localChange: true,
    serverChange: false,
    log: null,
  };
  allLogs.forEach((localLog, index) => {
    if (localLog.id) {
      /*
        If a local log has an id field, see if it is the same as the server log.
        In this case set lotStatus.localId and .storeIndex
        Also check whethe the log is unsynced (wasPushedToServer true)
      */
      if (localLog.id === serverLog.id) {
        logStatus.localId = localLog.local_id;
        logStatus.storeIndex = index;
        if (JSON.parse(localLog.wasPushedToServer) === true) {
          logStatus.localChange = false;
        } else {
          logStatus.log = localLog;
        }
        if (+serverLog.changed > +syncDate) {
          logStatus.serverChange = true;
        }
      }
    }
  });
  return logStatus;
}

// Process each log on its way from the server to the logFactory
function processLog(log, checkStatus, syncDate) {
  /*
  If the log is not present locally, return the server version.
  If the log is present locally, but has not been changed since the last sync,
  return the new version from the server (with local_id)
  If the log is present locally and has been changed, check log.changed from the server
  against the changed property of each log attribute
   - If any attribute has been changed more recently than the server log, keep it
   - Otherwise take changes from the server
  */
  if (checkStatus.localId === null) {
    return makeLog.fromServer({
      ...log,
      wasPushedToServer: true,
      // Trying to make isReady..
      isReadyToSync: false,
      done: (parseInt(log.done, 10) === 1),
    });
  }
  if (!checkStatus.localChange && checkStatus.serverChange) {
    // Update the log with all data from the server
    return makeLog.fromServer({
      ...log,
      wasPushedToServer: true,
      isReadyToSync: false,
      local_id: checkStatus.localId,
      done: (parseInt(log.done, 10) === 1),
    });
  }
  /*
  Replace properties of the local log that have not been modified since
  the last sync with data from the server.
  For properties that have been completed since the sync date,
  Present choice to retain either the log or the server version
  */
  const storeLog = checkStatus.log;
  const servLogBuilder = {};
  const locLogBuilder = {};

  /*
  We compare changed dates for local log properties against the date of last sync.
  madeFromServer is used as a source
  for building the merged log, to keep formatting consistent
  */
  const madeFromServer = makeLog.fromServer(log);
  Object.keys(storeLog).forEach((key) => {
    if (storeLog[key].changed && storeLog[key].changed !== null) {
      if (+storeLog[key].changed < +syncDate) {
        servLogBuilder[key] = madeFromServer[key];
      } else {
        locLogBuilder[key] = storeLog[key];
      }
    }
  });
  return makeLog.toStore({
    ...locLogBuilder,
    ...servLogBuilder,
    wasPushedToServer: false,
    local_id: checkStatus.localId,
    id: log.id,
    done: {
      changed: Math.floor(Date.now() / 1000),
      data: (+log.done === 1),
    },
    isReadyToSync: true,
  });
}
