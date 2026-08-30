// Name pools. Data only, no logic. 1890s English industrial city, which means
// Old Testament given names on the working bank and Latinate ones on the polite one.

export const GIVEN_M: readonly string[] = [
  'Aldous', 'Ambrose', 'Barnaby', 'Cecil', 'Clement', 'Cuthbert', 'Ebenezer', 'Edmund',
  'Elias', 'Ezra', 'Gideon', 'Hollis', 'Horace', 'Ignatius', 'Jabez', 'Jethro',
  'Josiah', 'Lambert', 'Leopold', 'Mordecai', 'Nathaniel', 'Obadiah', 'Percival',
  'Peregrine', 'Quentin', 'Reuben', 'Septimus', 'Silas', 'Thaddeus', 'Tobias',
  'Ulysses', 'Vernon', 'Wilbur', 'Zachariah', 'Alfred', 'Arthur', 'Walter', 'Ernest',
];

export const GIVEN_F: readonly string[] = [
  'Adelaide', 'Agnes', 'Almira', 'Beatrix', 'Cordelia', 'Constance', 'Dorcas', 'Edith',
  'Eliza', 'Esther', 'Euphemia', 'Faith', 'Georgiana', 'Harriet', 'Hepzibah', 'Honoria',
  'Imogen', 'Jemima', 'Keziah', 'Lavinia', 'Letitia', 'Mabel', 'Marguerite', 'Millicent',
  'Nell', 'Ottoline', 'Patience', 'Prudence', 'Rosamund', 'Sybil', 'Tabitha', 'Temperance',
  'Ursula', 'Verity', 'Wilhelmina', 'Winifred', 'Clara', 'Ada',
];

export const FAMILY: readonly string[] = [
  'Ashbee', 'Bellwether', 'Birdwhistle', 'Blacklock', 'Bramhall', 'Carrick', 'Chadwick',
  'Coldrick', 'Crake', 'Crowther', 'Dunnage', 'Fairweather', 'Garrow', 'Glass', 'Grimsditch',
  'Halloran', 'Hardcastle', 'Hollowell', 'Kettleby', 'Larkspur', 'Lindsell', 'Mallender',
  'Marchbank', 'Mowbray', 'Naseby', 'Netherby', 'Ockenden', 'Pargeter', 'Pennyquick',
  'Prynne', 'Quilliam', 'Radcliffe', 'Rookwood', 'Sallow', 'Shackleton', 'Sowerby',
  'Standish', 'Thackray', 'Threlfall', 'Underhill', 'Venn', 'Wenn', 'Whitlock', 'Woolnough',
  'Yardley', 'Ainsworth', 'Braithwaite', 'Cholmondeley', 'Dewhurst', 'Entwistle',
];

export const STREET_HEAD: readonly string[] = [
  'Copper', 'Foundry', 'Lamp', 'Gilder', 'Cinder', 'Ash', 'Bell', 'Vellum', 'Anchor',
  'Cable', 'Vane', 'Kiln', 'Salt', 'Tallow', 'Chandler', 'Cooper', 'Pewter', 'Verdigris',
  'Bishop', 'Regent', 'Jubilee', 'Crown', 'Corn', 'Wool', 'Glass', 'Iron', 'Paper',
  'Printer', 'Pilgrim', 'Angel', 'Bridewell', 'Sparrow', 'Magpie', 'Thistle', 'Rope',
];

export const STREET_TAIL: readonly string[] = [
  'Row', 'Lane', 'Street', 'Walk', 'Rise', 'Terrace', 'Yard', 'Passage', 'Way',
  'Crescent', 'Hill', 'Gate', 'Steps', 'Alley', 'Parade', 'Mews',
];

export const PUB_HEAD: readonly string[] = [
  'The Brass', 'The Iron', 'The Crooked', 'The Sunken', 'The Gilded', 'The Weary',
  'The Honest', 'The Patient', 'The Drowned', 'The Whistling', 'The Ninth', 'The Old',
];

export const PUB_TAIL: readonly string[] = [
  'Pennant', 'Kettle', 'Lamplighter', 'Ferryman', 'Compass', 'Anvil', 'Sparrow',
  'Cormorant', 'Ledger', 'Bellows', 'Anchor', 'Verger', 'Cog', 'Hound',
];

export const FIRM_HEAD: readonly string[] = [
  'Sallow', 'Marchbank', 'Threlfall', 'Ockenden', 'Pennyquick', 'Hardcastle',
  'Crowther', 'Netherby', 'Standish', 'Woolnough', 'Grimsditch', 'Bramhall',
];

export const FIRM_TAIL: readonly string[] = [
  'and Sons', 'and Company', 'Brothers', 'and Nephew', 'and Daughters',
  'Limited', 'and Partners', 'and Co.',
];

export const SHOP_TRADE: readonly string[] = [
  'Draper', 'Grocer', 'Ironmonger', 'Chandler', 'Stationer', 'Tobacconist',
  'Confectioner', 'Bootmaker', 'Watchmaker', 'Fishmonger', 'Apothecary',
  'Pawnbroker', 'Bookbinder', 'Milliner', 'Butcher', 'Baker',
];

export const GRUDGE_TOPIC: readonly string[] = [
  'drainage', 'a boundary wall', 'the church pew rents', 'a will', 'the well',
  'a right of way', 'the smell from the yard', 'an unpaid account', 'a dog',
  'the noise of the presses', 'a shared chimney', 'the tolls on the bridge',
  'a broken window nobody admits to', 'the position of a gate', 'a dowry',
  'who owns the light in the passage', 'a misread survey', 'the rates',
];

/** Landmark names. Fixed, because these nine are the postcard. */
export const LANDMARK_NAMES: Record<string, string> = {
  townhall: 'The Town Hall',
  exchange: 'The Corn Exchange',
  newspaper: 'The Verdigris Herald',
  constabulary: 'The Constabulary',
  gasworks: 'The Gasworks',
  pumphouse: 'The Pumphouse',
  tramdepot: 'The Tram Depot',
  mast: 'The Mooring Mast',
  chapel: 'St Cuthbert Without',
  dispensary: 'The Public Dispensary',
  postexchange: 'The Pneumatic Exchange',
  school: 'The Board School',
  bathhouse: 'The Public Baths',
  glasshouse: 'The Winter Garden',
  bank: 'The District and County Bank',
};
