/*
  SOURCES & DESTINATIONS
  Theses constants are assigned to string values representing the possible
  sources & destinations to/from which the logs may be sent.
*/
const SERVER = 'FARMOS_SERVER';
const STORE = 'VUEX_STORE';
const IDB = 'INDEXEDDB';
const nowStamp = (Date.now() / 1000).toFixed(0);

/*
  parseImagesFromServer and parseObjects are used both in src: store and src: SQL
  For now, I will retain them in their original form, and use only on the data: property

  This utility function, along with the use of `JSON.parse()` above,
  provide a quick hacky solution, but we need something better
  for parsing data when it goes between Vuex and WebSQL. See:
  https://github.com/farmOS/farmOS-native/issues/27#issuecomment-412093491
  https://github.com/farmOS/farmOS-native/issues/40#issuecomment-419131892
  https://github.com/farmOS/farmOS-native/issues/45
*/
function parseImagesFromServer(x) {
  // Image references obtained from the server are objects
  if (typeof x === 'object') {
    const imageArray = [];
    if (Array.isArray(x)) {
      x.forEach((img) => {
        if (typeof img === 'string') {
          imageArray.push(img);
        } else {
          Object.keys(img).forEach((key) => {
            if (img[key].id) {
              imageArray.push(`${img[key].id}`);
            } else {
              imageArray.push(img[key]);
            }
          });
        }
      });
    } else {
      Object.keys(x).forEach((key) => {
        imageArray.push(x[key]);
      });
    }
    return imageArray;
  }
  if (typeof x === 'string') {
    return (x === '') ? [] : [].concat(x);
  }
  throw new Error(`${x} cannot be parsed as an image array`);
}

// TODO: can this be used in place of parseImagesFromServer?
function parseObjects(x) {
  if (typeof x === 'object') {
    return x;
  }
  if (typeof x === 'string') {
    return JSON.parse(x);
  }
  throw new Error(`${x} cannot be parsed as an object array`);
}

// format images for the payload
function prepareImagesForServer(images) {
  if (Array.isArray(images)) {
    return images.map((img) => {
      // Files begin with 'data:'.  Retain file strings, turn ref strings into objects
      if (img.charAt(0) === 'd') {
        return img;
      }
      return { fid: img };
    });
  }
  return images;
}

// Pull value from SERVER notes and remove html tags
function parseNotes(notes) {
  if (notes.value !== undefined) {
    if (notes.value !== '' && notes.value !== null) {
      return notes.value.slice(3, -5);
    }
  }
  return '';
}

/*
  MAKELOGFACTORY
  This factory function yields several utility functions for structuring logs
  within the app. It can be applied to an existing log before storing it in the
  database, posting it to the server, or for otherwise rendering logs in a
  standard format. It can also be used to generate a new log for the Vuex store
  by passing in no parameters. Provide a `dest` parameter to ensure the proper
  formatting for its destination. Provide a `src` parameter so it knows what
  formatting to expect from its source.
*/

const makeLogFactory = (src, dest) => {
  if (src === STORE || src === undefined) {
    return ({
      // Assign default properties or leave them as optional
      log_owner = { changed: null, data: '' }, // eslint-disable-line camelcase
      // Quantity will be an array of objects, similar to area or asset
      quantity = { changed: null, data: [] },
      log_category = { changed: null, data: [] }, // eslint-disable-line camelcase
      equipment = { changed: null, data: [] },
      id,
      local_id, // eslint-disable-line camelcase
      name = { changed: null, data: '' },
      type = { changed: null, data: '' },
      timestamp = { changed: null, data: '' },
      images = { changed: null, data: [] },
      done = { changed: null, data: true },
      isCachedLocally = false,
      isReadyToSync = false,
      wasPushedToServer = false,
      remoteUri = '',
      asset = { changed: null, data: [] },
      area = { changed: null, data: [] },
      geofield = { changed: null, data: [] },
      notes = { changed: null, data: '' },
      movement = { changed: null, data: { area: [], geometry: '' } },
    } = {}) => {
      let log;
      /*
        The format for adding logs to the Vuex store; this is also the default
        if there is no destination argument passed.
      */
      if (dest === STORE || dest === undefined) {
        log = {
          log_owner,
          notes,
          quantity: {
            data: parseObjects(quantity.data),
            changed: quantity.changed,
          },
          log_category: {
            data: parseObjects(log_category.data),
            changed: log_category.changed,
          },
          equipment: {
            data: parseObjects(equipment.data),
            changed: equipment.changed,
          },
          id,
          local_id,
          name,
          type,
          timestamp,
          images: {
            data: parseImagesFromServer(images.data),
            changed: images.changed,
          },
          // Use JSON.parse() to convert strings back to booleans
          done: { data: JSON.parse(done.data), changed: done.changed },
          isCachedLocally: JSON.parse(isCachedLocally),
          isReadyToSync: JSON.parse(isReadyToSync),
          wasPushedToServer: JSON.parse(wasPushedToServer),
          remoteUri,
          asset: {
            data: parseObjects(asset.data),
            changed: asset.changed,
          },
          movement: {
            data: parseObjects(movement.data),
            changed: movement.changed,
          },
        };
        if (type.data !== 'farm_seeding' && area) {
          log.area = {
            data: parseObjects(area.data),
            changed: area.changed,
          };
        }
        if (type.data !== 'farm_seeding' && geofield) {
          log.geofield = {
            data: parseObjects(geofield.data),
            changed: geofield.changed,
          };
        }
      }
      // The format for sending logs to the farmOS REST Server.
      if (dest === SERVER) {
        log = {
          notes: {
            format: 'farm_format',
            value: notes.data,
          },
          name: name.data,
          done: done.data ? 1 : 0,
          type: type.data,
          timestamp: timestamp.data,
          images: prepareImagesForServer(images.data),
          asset: asset.data,
          quantity: quantity.data,
          log_category: log_category.data,
          equipment: equipment.data,
          movement: movement.data,
        };
        /*
          Only return id property if one has already been assigned by the server,
          otherwise omit it so the server can assign a new one.
        */
        if (id) {
          log.id = id;
        }
        // Seedings do not have areas and geofields
        if (type.data !== 'farm_seeding' && area) {
          log.area = area.data;
        }
        if (type.data !== 'farm_seeding' && geofield) {
          log.geofield = geofield.data;
        }
      }
      // The format for inserting logs in IDB for local persistence.
      if (dest === IDB) {
        log = {
          log_owner,
          notes,
          quantity,
          log_category,
          equipment,
          id,
          name,
          type,
          timestamp,
          images,
          done,
          wasPushedToServer,
          remoteUri,
          asset,
          movement,
        };
        /*
          Only return local_id property if one has already been assigned by WebSQL,
          otherwise let WebSQL assign a new one.
        */
        if (local_id) { // eslint-disable-line camelcase
          log.local_id = local_id; // eslint-disable-line camelcase
        }
        // Seedings do not have areas and geofields
        if (type.data !== 'farm_seeding' && area) {
          log.area = area;
        }
        if (type.data !== 'farm_seeding' && geofield) {
          log.geofield = geofield;
        }
      }
      return log;
    };
  }
  if (src === SERVER) {
    return (deserializedLogFromServer) => {
      // Assign default properties or leave them as optional
      const {
        log_owner, // eslint-disable-line camelcase
        quantity,
        log_category, // eslint-disable-line camelcase
        equipment,
        id,
        local_id, // eslint-disable-line camelcase
        name,
        type,
        timestamp,
        images,
        done,
        url,
        asset,
        area,
        geofield,
        notes,
        movement,
      } = deserializedLogFromServer;
      const log = {
        log_owner: { data: log_owner, changed: nowStamp },
        notes: { data: parseNotes(notes), changed: nowStamp },
        quantity: { data: quantity, changed: nowStamp },
        log_category: { data: log_category, changed: nowStamp },
        equipment: { data: equipment, changed: nowStamp },
        local_id,
        name: { data: name, changed: nowStamp },
        type: { data: type, changed: nowStamp },
        timestamp: { data: timestamp, changed: nowStamp },
        images: { data: images, changed: nowStamp },
        done: { data: done, changed: nowStamp },
        isCachedLocally: false,
        wasPushedToServer: true,
        remoteUri: url,
        asset: { data: asset, changed: nowStamp },
        movement: { data: movement, changed: nowStamp },
      };
      // Seedings do not have areas and geofields
      if (type !== 'farm_seeding' && area) {
        log.area = { data: area, changed: nowStamp };
      }
      if (type !== 'farm_seeding' && geofield) {
        log.geofield = { data: geofield, changed: nowStamp };
      }
      if (id) {
        log.id = id;
      }
      return log;
    };
  }
  throw new Error('Incorrect parameters passed to makeLog');
};

export default {
  create: makeLogFactory(),
  toStore: makeLogFactory(STORE, STORE),
  toIdb: makeLogFactory(STORE, IDB),
  toServer: makeLogFactory(STORE, SERVER),
  fromServer: makeLogFactory(SERVER, STORE),
};
