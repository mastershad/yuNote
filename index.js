import 'react-native-get-random-values';
import { AppRegistry } from 'react-native';
import App from './App';
import { processTransportMessage } from './src/relay/processTransportMessage';

AppRegistry.registerComponent('yuNote', () => App);
AppRegistry.registerHeadlessTask('YunoteTransportTask', () => processTransportMessage);

