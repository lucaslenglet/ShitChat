// Random display names: "<Adjective> <Animal>".

const ADJECTIVES = [
  "Grumpy", "Masked", "Hasty", "Absent-minded", "Cranky", "Dreamy", "Shy",
  "Chatty", "Mysterious", "Cheeky", "Sleepy", "Hungry", "Puzzled", "Sniffly",
  "Chubby", "Zen", "Panicked", "Stubborn", "Sly", "Mocking", "Skeptical",
  "Chilly", "Pensive", "Sneaky", "Elegant", "Dramatic", "Philosophical",
  "Caffeinated", "Hyper", "Discreet", "Shifty", "Scruffy", "Fiery", "Gallant",
  "Taciturn", "Wobbly", "Smug", "Fluffy", "Clumsy", "Suspicious",
];

const ANIMALS = [
  "Raccoon", "Badger", "Owl", "Llama", "Panda", "Koala", "Beaver", "Penguin",
  "Hedgehog", "Platypus", "Wombat", "Armadillo", "Sloth", "Yak", "Wildebeest",
  "Lemur", "Warthog", "Narwhal", "Walrus", "Ferret", "Squirrel", "Hamster",
  "Duck", "Octopus", "Squid", "Lobster", "Crab", "Toucan", "Flamingo",
  "Pelican", "Capybara", "Meerkat", "Chinchilla", "Axolotl", "Camel", "Bison",
  "Fox", "Guinea Pig", "Alpaca", "Tapir", "Okapi", "Fennec", "Lynx", "Pangolin",
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function randomName() {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}
